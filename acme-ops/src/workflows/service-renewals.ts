import { z } from "zod";
import { firstFreeSlot, type Slot } from "../providers/google";
import { type StripeSubscription, stripeTime } from "../providers/stripe";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { Approvers, ChannelId, Email, messageId, money, out, shortHash } from "./shared";

// Customer Success org · cs-ops team.
// Trigger: weekly schedule. Monitoring and calibration contracts are Stripe
// subscriptions; every one renewing inside the window gets an owner task, a
// renewal draft and a slot for the renewal call. A price uplift within policy
// is scheduled automatically; above policy it waits for approval.

const Input = z.object({
  csChannel: ChannelId,
  asanaWorkspace: z.string().min(1).default("acme-cs"),
  csmCalendarId: z.string().min(1).default("primary"),
  /** Evaluation date (YYYY-MM-DD); defaults to the run's start. */
  asOf: z.iso.date().optional(),
  windowDays: z.number().int().min(1).max(365).default(90),
  /** Restrict the sweep to these accounts (the CSM's book); empty = every renewing contract. */
  accounts: z.array(Email).max(200).default([]),
  /** Uplift to apply at renewal, in percent. */
  upliftPct: z.number().min(0).max(50).default(0),
  /** Uplifts up to this are scheduled without approval. */
  maxAutoUpliftPct: z.number().min(0).max(50).default(5),
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

export interface Renewal {
  subscriptionId: string;
  customerId: string;
  email: string;
  name?: string | null;
  status: string;
  renewsOn: string;
  daysToRenewal: number;
  band: 30 | 60 | 90;
  amountMinor: number;
  currency: string;
  interval: string;
}

const STEP: Record<string, (d: Date, n: number) => void> = {
  day: (d, n) => d.setUTCDate(d.getUTCDate() + n),
  week: (d, n) => d.setUTCDate(d.getUTCDate() + 7 * n),
  month: (d, n) => d.setUTCMonth(d.getUTCMonth() + n),
  year: (d, n) => d.setUTCFullYear(d.getUTCFullYear() + n),
};

/**
 * Next renewal strictly after `now`: Stripe's current_period_end when it is a
 * real future date, otherwise the subscription start advanced by whole intervals.
 */
export function nextRenewal(sub: { current_period_end?: number | string | null; created?: number | string | null; start_date?: number | string | null }, interval: string, count: number, now: number): number | undefined {
  const end = stripeTime(sub.current_period_end);
  if (end !== undefined && end > now && end > Date.UTC(2000, 0, 1)) return end;
  const start = stripeTime(sub.created) ?? stripeTime(sub.start_date);
  const step = STEP[interval];
  if (start === undefined || start < Date.UTC(2000, 0, 1) || !step) return undefined;
  const d = new Date(start);
  for (let i = 0; i < 10_000 && d.getTime() <= now; i++) step(d, Math.max(1, count));
  return d.getTime();
}

type PriceInfo = { unit_amount: number | null; currency: string; recurring?: { interval: string; interval_count?: number } | null };

async function updateSubscriptionMetadata(stripe: NonNullable<import("../providers").Providers["stripe"]>, id: string, metadata: Record<string, string>): Promise<StripeSubscription> {
  const form: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadata)) form[`metadata[${k}]`] = v;
  return (await stripe.http.request<StripeSubscription>("POST", `/v1/subscriptions/${encodeURIComponent(id)}`, { form })).body;
}

export const serviceRenewals: WorkflowDef<Input> = {
  id: "service-renewals",
  title: "Service and monitoring renewals",
  org: "Customer Success",
  team: "cs-ops",
  description:
    "Sweep monitoring and calibration contracts (Stripe subscriptions) renewing in the next 30/60/90 days; create the owner's renewal task, draft the renewal email, find a call slot and post a digest. Uplifts above policy wait for approval.",
  input: Input,
  agents: [
    {
      name: "renewal-ledger",
      needs: ["stripe"],
      async run({ input, providers, startedAt }) {
        const stripe = providers.stripe!;
        const now = input.asOf ? Date.parse(`${input.asOf}T00:00:00Z`) : startedAt.getTime();
        const [subs, customers, prices] = await Promise.all([stripe.listSubscriptions(), stripe.listCustomers(), stripe.listPrices()]);
        const priceById = new Map(prices.map((p) => [p.id, p as PriceInfo]));
        const custById = new Map(customers.map((c) => [c.id, c]));
        const book = new Set(input.accounts);
        const renewals: Renewal[] = [];
        for (const s of subs as (StripeSubscription & { current_period_end?: number | string; created?: number | string; start_date?: number | string; currency?: string })[]) {
          if (!["active", "trialing", "past_due", "unpaid"].includes(s.status)) continue;
          const c = custById.get(s.customer);
          const email = c?.email?.toLowerCase();
          if (!email || (book.size && !book.has(email))) continue;
          // Item price is an object on real Stripe; some backends send only its id.
          const items = s.items?.data ?? [];
          const resolved = items.map((it) => {
            const raw = it.price as unknown;
            const p = typeof raw === "string" ? priceById.get(raw) : (raw as PriceInfo | undefined) ?? undefined;
            return { p, qty: it.quantity ?? 1 };
          });
          const first = resolved.find((r) => r.p?.recurring)?.p;
          if (!first?.recurring) continue;
          const when = nextRenewal(s, first.recurring.interval, first.recurring.interval_count ?? 1, now);
          if (when === undefined) continue;
          const days = Math.ceil((when - now) / 86_400_000);
          if (days < 0 || days > input.windowDays) continue;
          renewals.push({
            subscriptionId: s.id,
            customerId: s.customer,
            email,
            name: c?.name ?? null,
            status: s.status,
            renewsOn: new Date(when).toISOString().slice(0, 10),
            daysToRenewal: days,
            band: days <= 30 ? 30 : days <= 60 ? 60 : 90,
            amountMinor: resolved.reduce((n, r) => n + (r.p?.unit_amount ?? 0) * r.qty, 0),
            currency: first.currency ?? "usd",
            interval: first.recurring.interval,
          });
        }
        renewals.sort((a, b) => a.daysToRenewal - b.daysToRenewal || a.subscriptionId.localeCompare(b.subscriptionId));
        return { summary: `${renewals.length} contract(s) renew within ${input.windowDays} days`, data: { renewals } };
      },
    },
    {
      name: "account-context",
      needs: ["hubspot", "stripe"],
      async run({ input, providers }) {
        const customers = await providers.stripe!.listCustomers();
        const emails = [...new Set(customers.map((c) => c.email?.toLowerCase()).filter((e): e is string => !!e && (!input.accounts.length || input.accounts.includes(e))))].sort();
        const byEmail: Record<string, { contactId: string; owner?: string; stage?: string }> = {};
        for (const email of emails) {
          const c = await providers.hubspot!.findByEmail(email);
          if (c) byEmail[email] = { contactId: c.id, owner: c.properties.hubspot_owner_id ?? undefined, stage: c.properties.lifecyclestage ?? undefined };
        }
        return { summary: `${Object.keys(byEmail).length} account(s) found in HubSpot`, data: { byEmail } };
      },
    },
    {
      name: "renewal-call-slots",
      needs: ["calendar"],
      async run({ input, providers, startedAt }) {
        const busy = await providers.calendar!.busy(input.csmCalendarId, startedAt.toISOString(), new Date(startedAt.getTime() + 21 * 86_400_000).toISOString());
        const slots: Slot[] = [];
        for (let k = 0; k < 20; k++) {
          const s = firstFreeSlot([...busy, ...slots], startedAt, 30, 15);
          if (!s) break;
          slots.push(s);
        }
        return { summary: `${slots.length} renewal-call slot(s) free`, data: { slots } };
      },
    },
  ],

  plan({ input }, results) {
    const ledger = out<{ renewals: Renewal[] }>(results, "renewal-ledger");
    if (!ledger) return [];
    const crm = out<{ byEmail: Record<string, { owner?: string; stage?: string }> }>(results, "account-context")?.byEmail ?? {};
    const slots = out<{ slots: Slot[] }>(results, "renewal-call-slots")?.slots ?? [];
    const actions: PlannedAction<Input>[] = [];
    if (!ledger.renewals.length) return actions;

    const uplift = (r: Renewal) => Math.round(r.amountMinor * (1 + input.upliftPct / 100));
    actions.push({
      id: "slack.post_renewal_digest",
      kind: "slack.post_renewal_digest",
      provider: "slack",
      agent: "renewal-ledger",
      gate: "auto",
      summary: { channel: input.csChannel, renewals: ledger.renewals.length },
      async execute({ providers }) {
        const text = [
          `*Renewals* — ${ledger.renewals.length} contract(s) in the next ${input.windowDays} days${input.upliftPct ? `, proposed uplift ${input.upliftPct}%` : ""}.`,
          ...ledger.renewals.map((r) => `• ${r.band}d ${r.email} ${r.subscriptionId} renews ${r.renewsOn} · ${money(r.amountMinor, r.currency)}/${r.interval}${r.status !== "active" ? ` · ${r.status.toUpperCase()}: collect before renewing` : ""}${crm[r.email]?.owner ? ` · owner ${crm[r.email]!.owner}` : ""}`),
        ].join("\n");
        const m = await providers.slack!.postMessage(input.csChannel, text);
        return { ref: m.ts, detail: { channel: m.channel } };
      },
    });

    ledger.renewals.forEach((r, idx) => {
      const key = shortHash(r.subscriptionId);
      const slot = slots[idx];
      actions.push({
        id: `asana.renewal_task:${key}`,
        kind: "asana.renewal_task",
        provider: "asana",
        agent: "renewal-ledger",
        gate: "auto",
        summary: { account: r.email, subscriptionId: r.subscriptionId, dueOn: r.renewsOn },
        async execute({ providers }) {
          const t = await providers.asana!.createTask({
            name: `Renewal: ${r.name ?? r.email} (${r.renewsOn})`,
            notes: `Subscription ${r.subscriptionId} renews ${r.renewsOn} at ${money(r.amountMinor, r.currency)}/${r.interval}.${input.upliftPct ? ` Proposed uplift ${input.upliftPct}% → ${money(uplift(r), r.currency)}.` : ""}${slot ? ` Suggested call: ${slot.start}.` : ""}${r.status !== "active" ? ` Account is ${r.status}: collect first.` : ""}`,
            workspace: input.asanaWorkspace,
            due_on: r.renewsOn,
          });
          return { ref: t.gid };
        },
        async reconcile({ providers }, receipt) {
          const t = await providers.asana!.getTask(receipt.ref);
          return t.completed ? { status: "match", detail: "renewal task completed" } : { status: "match", detail: "renewal task open" };
        },
      });
      const first = r.name?.split(" ")[0] ?? "there";
      actions.push({
        id: `gmail.draft_renewal:${key}`,
        kind: "gmail.draft_renewal",
        provider: "gmail",
        agent: "renewal-ledger",
        gate: "auto",
        summary: { to: r.email, renewsOn: r.renewsOn, sent: false },
        async execute({ providers, runId }) {
          const d = await providers.gmail!.createDraft({
            to: r.email,
            subject: `Your ACME monitoring contract renews on ${r.renewsOn}`,
            body: `Hi ${first},\n\nYour ACME monitoring and calibration contract renews on ${r.renewsOn}.${slot ? ` Could we review coverage and next year's plan on ${slot.start.slice(0, 16).replace("T", " ")} UTC?` : " I'd like to set up a short review call."}\n\nBest,\nYour ACME customer success manager`,
            messageId: messageId(runId, `renewal-${key}`),
          });
          return { ref: d.id };
        },
      });
      // No uplift on an account that owes money: collections comes first.
      if (input.upliftPct > 0 && r.status === "active") {
        const gate = input.upliftPct > input.maxAutoUpliftPct ? "approval" : "auto";
        actions.push({
          id: `stripe.schedule_uplift:${key}`,
          kind: "stripe.schedule_uplift",
          provider: "stripe",
          agent: "renewal-ledger",
          gate,
          summary: { subscriptionId: r.subscriptionId, account: r.email, upliftPct: input.upliftPct, policyMaxPct: input.maxAutoUpliftPct, from: money(r.amountMinor, r.currency), to: money(uplift(r), r.currency), effective: r.renewsOn },
          async execute({ providers, runId }) {
            const s = await updateSubscriptionMetadata(providers.stripe!, r.subscriptionId, {
              renewal_uplift_pct: String(input.upliftPct),
              renewal_amount: String(uplift(r)),
              renewal_effective: r.renewsOn,
              renewal_run: runId,
            });
            return { ref: s.id, detail: { upliftPct: input.upliftPct } };
          },
          async reconcile({ providers }, receipt) {
            const s = await providers.stripe!.getSubscription(receipt.ref);
            const got = s.metadata?.renewal_uplift_pct;
            return got === String(input.upliftPct) ? { status: "match" } : { status: "drift", detail: `renewal_uplift_pct is ${got ?? "unset"}` };
          },
        });
      }
    });
    return actions;
  },

  output({ input }, results) {
    const ledger = out<{ renewals: Renewal[] }>(results, "renewal-ledger");
    if (!ledger) return { evaluated: false };
    const r = ledger.renewals;
    return {
      evaluated: true,
      renewing: r.length,
      byBand: { d30: r.filter((x) => x.band === 30).length, d60: r.filter((x) => x.band === 60).length, d90: r.filter((x) => x.band === 90).length },
      notActive: r.filter((x) => x.status !== "active").length,
      upliftPct: input.upliftPct,
      upliftNeedsApproval: input.upliftPct > input.maxAutoUpliftPct,
      renewals: r,
    };
  },

  catalog: [
    { kind: "slack.post_renewal_digest", provider: "slack", gate: "auto", description: "Post the renewal digest to the CS channel" },
    { kind: "asana.renewal_task", provider: "asana", gate: "auto", description: "Create the owner's renewal task, due on the renewal date" },
    { kind: "gmail.draft_renewal", provider: "gmail", gate: "auto", description: "Create (not send) the renewal email draft" },
    { kind: "stripe.schedule_uplift", provider: "stripe", gate: "approval", description: "Schedule the renewal price uplift on the subscription (auto when within policy)" },
  ],
};
