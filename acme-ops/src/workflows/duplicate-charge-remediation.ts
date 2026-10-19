import { z } from "zod";
import { FatalError } from "../kit/errors";
import type { AgentResults, PlannedAction, WorkflowDef } from "../kit/types";
import type { StripeClient, StripePaymentIntent } from "../providers/stripe";
import { stripeTime } from "../providers/stripe";
import { Approvers, ChannelId, Email, messageId, money, out, plain, shortHash } from "./shared";

// Finance · billing-ops.
// Trigger: a billing incident (e.g. a payment-retry job that ran twice) with the
// customers it may have affected. Duplicates are refunded under hard limits.

/** Limits live in code: a trigger can't raise them. */
export const POLICY = {
  /** Two payments with the same amount and reference this close together are one purchase charged twice. */
  matchWithinMinutes: 15,
  /** A single refund above this waits for approval. */
  autoRefundMaxMinor: 50_000,
  /** Refunds go out automatically until their sum reaches this; the rest wait for approval. */
  autoBatchMaxMinor: 200_000,
  /** Beyond either ceiling the incident is too big for automation: nothing is refunded, people take over. */
  hardMaxRefunds: 100,
  hardMaxTotalMinor: 2_500_000,
  maxWindowDays: 7,
} as const;

const Input = z
  .object({
    incidentId: z.string().regex(/^[\w.-]{3,64}$/, "incident id like INC-2026-1018"),
    description: z.string().min(1).max(2000),
    window: z.object({ from: z.iso.datetime(), to: z.iso.datetime() }),
    /** Customers the incident may have touched (from the incident query). Never "everyone". */
    customers: z.array(Email).min(1).max(200),
    financeChannel: ChannelId,
    /** Asana workspace (or project) that keeps the remediation record. */
    financeWorkspace: z.string().min(1).default("acme-finance"),
    approvers: Approvers,
  })
  .refine((i) => Date.parse(i.window.to) > Date.parse(i.window.from), { message: "window.to must be after window.from", path: ["window"] })
  .refine((i) => Date.parse(i.window.to) - Date.parse(i.window.from) <= POLICY.maxWindowDays * 86_400_000, { message: `window longer than ${POLICY.maxWindowDays} days`, path: ["window"] });
type Input = z.infer<typeof Input>;

export interface Charge {
  paymentIntent: string;
  charge: string | null;
  amountMinor: number;
  refundedMinor: number;
  currency: string;
  createdMs: number;
  /** What the payment was for: invoice, subscription, order or description. Empty when unknown. */
  reference: string;
}
export interface Duplicate {
  email: string;
  customerId: string;
  paymentIntent: string;
  charge: string | null;
  original: string;
  amountMinor: number;
  currency: string;
  createdMs: number;
}
interface CustomerScan {
  email: string;
  customerId: string | null;
  duplicates: Duplicate[];
  /** Same amount close together but nothing says what they were for: a person decides. */
  ambiguous: string[];
  alreadyRefunded: string[];
}
interface Scan {
  customers: CustomerScan[];
}
interface Disputes {
  charges: string[];
  paymentIntents: string[];
}
interface Accounts {
  byEmail: Record<string, { found: boolean; company?: string; owner?: string }>;
}
export interface Planned extends Duplicate {
  gate: "auto" | "approval";
  why: string;
}
interface Plan {
  mode: "refund" | "halted" | "blocked" | "nothing";
  reason: string;
  refunds: Planned[];
  excluded: { paymentIntent: string; email: string; reason: string }[];
  ambiguous: number;
  notFound: string[];
  totals: { count: number; amountMinor: number; autoMinor: number; approvalMinor: number; currency: string };
}

/** Payments that charged the same purchase again within `POLICY.matchWithinMinutes` of the first. Pure. */
export function findDuplicates(charges: Charge[]): { duplicates: { charge: Charge; original: Charge }[]; ambiguous: Charge[] } {
  const sorted = [...charges].sort((a, b) => a.createdMs - b.createdMs || a.paymentIntent.localeCompare(b.paymentIntent));
  const within = POLICY.matchWithinMinutes * 60_000;
  const duplicates: { charge: Charge; original: Charge }[] = [];
  const ambiguous: Charge[] = [];
  const firsts: Charge[] = [];
  for (const c of sorted) {
    const twin = firsts.find((f) => f.amountMinor === c.amountMinor && f.currency === c.currency && c.createdMs - f.createdMs <= within && (f.reference === c.reference || !f.reference || !c.reference));
    if (!twin) firsts.push(c);
    else if (twin.reference && c.reference === twin.reference) duplicates.push({ charge: c, original: twin });
    else ambiguous.push(c);
  }
  return { duplicates, ambiguous };
}

/** Gates every refund and enforces the batch limits. Pure. */
export function gateRefunds(dups: Duplicate[]): { mode: "refund" | "halted"; reason: string; refunds: Planned[] } {
  const total = dups.reduce((s, d) => s + d.amountMinor, 0);
  if (dups.length > POLICY.hardMaxRefunds || total > POLICY.hardMaxTotalMinor) {
    return { mode: "halted", reason: `${dups.length} refund(s) totalling ${total} minor units exceed the automation ceiling (${POLICY.hardMaxRefunds} refunds / ${POLICY.hardMaxTotalMinor})`, refunds: [] };
  }
  let auto = 0;
  const refunds = [...dups]
    .sort((a, b) => a.createdMs - b.createdMs || a.paymentIntent.localeCompare(b.paymentIntent))
    .map((d): Planned => {
      if (d.amountMinor > POLICY.autoRefundMaxMinor) return { ...d, gate: "approval", why: "above the single-refund limit" };
      if (auto + d.amountMinor > POLICY.autoBatchMaxMinor) return { ...d, gate: "approval", why: "batch auto-refund limit reached" };
      auto += d.amountMinor;
      return { ...d, gate: "auto", why: "within limits" };
    });
  return { mode: "refund", reason: `${refunds.length} duplicate charge(s)`, refunds };
}

function reference(p: StripePaymentIntent & { description?: string | null }): string {
  const m = p.metadata ?? {};
  return m.invoice || m.invoice_id || m.subscription_id || m.order_id || (p as { invoice?: string | null }).invoice || p.description?.trim() || "";
}

async function refundedOf(stripe: StripeClient, pi: string): Promise<number> {
  return (await stripe.listRefundsForPaymentIntent(pi)).filter((r) => r.status !== "failed" && r.status !== "canceled").reduce((s, r) => s + r.amount, 0);
}

/** Bounded parallelism over the customer list. */
async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

const hash = (email: string) => shortHash("customer", email).slice(0, 10);

export const duplicateChargeRemediation: WorkflowDef<Input> = {
  id: "duplicate-charge-remediation",
  title: "Duplicate charge remediation",
  org: "Finance",
  team: "billing-ops",
  description:
    "After a billing incident, scan the affected customers' Stripe payments in the incident window, find purchases charged twice, exclude disputed and ambiguous ones, and refund the duplicates under hard limits: small refunds go out automatically, large ones and anything past the batch limit wait for approval, and an incident beyond the automation ceiling refunds nothing and goes to people. Customer notices are Gmail drafts; the record goes to Asana and Slack.",
  input: Input,
  agents: [
    {
      name: "charge-scan",
      needs: ["stripe"],
      async run({ input, providers }) {
        const stripe = providers.stripe!;
        const from = Date.parse(input.window.from);
        const to = Date.parse(input.window.to);
        const customers = await pool([...new Set(input.customers)], 5, async (email): Promise<CustomerScan> => {
          const cus = await stripe.findCustomerByEmail(email);
          if (!cus) return { email, customerId: null, duplicates: [], ambiguous: [], alreadyRefunded: [] };
          const pis = (await stripe.listPaymentIntents(cus.id)).filter((p) => {
            const t = stripeTime(p.created);
            return p.status === "succeeded" && (!p.customer || p.customer === cus.id) && t !== undefined && t >= from && t <= to;
          });
          const charges: Charge[] = pis.map((p) => ({
            paymentIntent: p.id,
            charge: p.latest_charge ?? null,
            amountMinor: p.amount_received ?? p.amount,
            refundedMinor: 0,
            currency: p.currency,
            createdMs: stripeTime(p.created)!,
            reference: reference(p),
          }));
          const found = findDuplicates(charges);
          const duplicates: Duplicate[] = [];
          const alreadyRefunded: string[] = [];
          for (const { charge, original } of found.duplicates) {
            const remaining = charge.amountMinor - (await refundedOf(stripe, charge.paymentIntent));
            if (remaining <= 0) alreadyRefunded.push(charge.paymentIntent);
            else duplicates.push({ email, customerId: cus.id, paymentIntent: charge.paymentIntent, charge: charge.charge, original: original.paymentIntent, amountMinor: remaining, currency: charge.currency, createdMs: charge.createdMs });
          }
          return { email, customerId: cus.id, duplicates, ambiguous: found.ambiguous.map((c) => c.paymentIntent), alreadyRefunded };
        });
        const n = customers.reduce((s, c) => s + c.duplicates.length, 0);
        return { summary: `${n} duplicate charge(s) across ${customers.filter((c) => c.duplicates.length).length} customer(s)`, data: { customers } satisfies Scan };
      },
    },
    {
      name: "dispute-check",
      needs: ["stripe"],
      async run({ providers }) {
        const ds = await providers.stripe!.listDisputes();
        // Refunding a disputed charge loses the money twice; any dispute state excludes it.
        const data: Disputes = { charges: ds.map((d) => d.charge).filter((c): c is string => !!c), paymentIntents: ds.map((d) => d.payment_intent).filter((c): c is string => !!c) };
        return { summary: `${ds.length} dispute(s) on file`, data };
      },
    },
    {
      name: "account-context",
      needs: ["hubspot"],
      async run({ input, providers }) {
        const byEmail: Accounts["byEmail"] = {};
        await pool([...new Set(input.customers)], 5, async (email) => {
          const c = await providers.hubspot!.findByEmail(email);
          byEmail[email] = c ? { found: true, company: c.properties.company ?? undefined, owner: c.properties.hubspot_owner_id ?? undefined } : { found: false };
        });
        return { summary: `${Object.values(byEmail).filter((a) => a.found).length}/${input.customers.length} in HubSpot`, data: { byEmail } satisfies Accounts };
      },
    },
  ],

  compose: {
    name: "remediation-plan",
    async run(_ctx, results) {
      const p = planFrom(results);
      return { summary: `${p.mode}: ${p.reason}`, data: p };
    },
  },

  plan({ input }, results) {
    const p = out<Plan>(results, "remediation-plan");
    if (!p) return [];
    const accounts = out<Accounts>(results, "account-context")?.byEmail ?? {};
    const actions: PlannedAction<Input>[] = [];

    for (const r of p.refunds) {
      actions.push({
        id: `stripe.refund_duplicate:${r.paymentIntent}`,
        kind: "stripe.refund_duplicate",
        provider: "stripe",
        agent: "remediation-plan",
        gate: r.gate,
        summary: { customer: hash(r.email), paymentIntent: r.paymentIntent, duplicateOf: r.original, amount: money(r.amountMinor, r.currency), why: r.why },
        async execute({ providers }) {
          const stripe = providers.stripe!;
          // A retry, or a second run of the same incident, finds its refund instead of refunding again.
          const prior = (await stripe.listRefundsForPaymentIntent(r.paymentIntent)).find((x) => x.metadata?.acme_incident === input.incidentId && x.status !== "failed" && x.status !== "canceled");
          if (prior) return { ref: prior.id, detail: { amountMinor: prior.amount, reused: true } };
          // Re-check at write time: someone may have refunded it by hand since the scan.
          const pi = await stripe.getPaymentIntent(r.paymentIntent);
          const remaining = (pi.amount_received ?? pi.amount) - (await refundedOf(stripe, r.paymentIntent));
          if (remaining < r.amountMinor) throw new FatalError(`${r.paymentIntent} now has ${remaining} refundable, planned ${r.amountMinor}`);
          const rf = await stripe.refundPaymentIntent(r.paymentIntent, r.amountMinor, { acme_incident: input.incidentId, acme_duplicate_of: r.original }, `${input.incidentId}-${r.paymentIntent}`);
          return { ref: rf.id, detail: { amountMinor: rf.amount, status: rf.status } };
        },
        async reconcile({ providers }, receipt) {
          const rf = await providers.stripe!.getRefund(receipt.ref);
          if (rf.status === "failed" || rf.status === "canceled") return { status: "drift", detail: `refund ${rf.status}` };
          return rf.amount === r.amountMinor ? { status: "match" } : { status: "drift", detail: `refund ${rf.amount}, expected ${r.amountMinor}` };
        },
      });
    }

    // One notice per customer, released with that customer's last refund (a draft: a person sends it).
    const byCustomer = new Map<string, Planned[]>();
    for (const r of p.refunds) byCustomer.set(r.email, [...(byCustomer.get(r.email) ?? []), r]);
    for (const [email, rs] of byCustomer) {
      const gate = rs.some((r) => r.gate === "approval") ? "approval" : "auto";
      const total = money(rs.reduce((s, r) => s + r.amountMinor, 0), rs[0]!.currency);
      const subject = `We refunded a duplicate charge (${total})`;
      const body = `Hello,\n\nA billing error on our side charged you twice for the same purchase. We've refunded ${rs.length === 1 ? "the duplicate charge" : `${rs.length} duplicate charges`} of ${total} to your original payment method; depending on your bank it shows up within 5-10 business days.\n\nWe're sorry for the trouble. Your reference is ${input.incidentId}.\n\nACME Billing`;
      actions.push({
        id: `gmail.draft_notice:${hash(email)}`,
        kind: "gmail.draft_notice",
        provider: "gmail",
        agent: "remediation-plan",
        gate,
        summary: { customer: hash(email), refunds: rs.length, total, sent: false },
        async execute({ providers, runId, applied }) {
          // Never tell a customer about a refund that didn't go out.
          const missing = rs.filter((r) => !applied[`stripe.refund_duplicate:${r.paymentIntent}`]);
          if (missing.length) throw new FatalError(`refund(s) not issued yet: ${missing.map((m) => m.paymentIntent).join(", ")}`);
          const d = await providers.gmail!.createDraft({ to: email, subject, body, messageId: messageId(runId, `dup-${hash(email)}`) });
          return { ref: d.id };
        },
      });
    }

    const t = p.totals;
    const lines = [
      `Incident ${input.incidentId}: ${plain(input.description, 300)}`,
      `Window ${input.window.from} to ${input.window.to}; ${input.customers.length} customer(s) scanned.`,
      `Decision: ${p.mode} (${p.reason}).`,
      `Refunds: ${t.count} for ${money(t.amountMinor, t.currency)} (${money(t.autoMinor, t.currency)} automatic, ${money(t.approvalMinor, t.currency)} awaiting approval).`,
      ...p.refunds.map((r) => `- ${r.paymentIntent} (duplicate of ${r.original}) ${money(r.amountMinor, r.currency)} ${r.gate}: ${r.why}${accounts[r.email]?.owner ? `; account owner ${accounts[r.email]!.owner}` : ""}`),
      ...p.excluded.map((x) => `- EXCLUDED ${x.paymentIntent}: ${x.reason}`),
      p.ambiguous ? `${p.ambiguous} same-amount payment(s) without a reference need a person.` : "",
      p.notFound.length ? `${p.notFound.length} address(es) have no Stripe customer.` : "",
    ].filter(Boolean);
    actions.push({
      id: "asana.remediation_record",
      kind: "asana.remediation_record",
      provider: "asana",
      agent: "remediation-plan",
      gate: "auto",
      summary: { incident: input.incidentId, mode: p.mode, refunds: t.count },
      async execute({ providers }) {
        const task = await providers.asana!.createTask({ name: `${input.incidentId}: duplicate charge remediation (${p.mode})`, notes: lines.join("\n"), workspace: input.financeWorkspace });
        return { ref: task.gid };
      },
      async reconcile({ providers }, receipt) {
        const task = await providers.asana!.getTask(receipt.ref);
        return task.name?.startsWith(input.incidentId) ? { status: "match" } : { status: "drift", detail: `task is now "${task.name}"` };
      },
    });

    const icon = p.mode === "refund" ? ":money_with_wings:" : p.mode === "nothing" ? ":white_check_mark:" : ":rotating_light:";
    const text = `${icon} ${input.incidentId}: ${p.mode === "refund" ? `${t.count} duplicate charge(s), ${money(t.amountMinor, t.currency)}; ${money(t.autoMinor, t.currency)} refunding now${t.approvalMinor ? `, ${money(t.approvalMinor, t.currency)} needs approval` : ""}` : p.reason}.${p.excluded.length ? ` ${p.excluded.length} excluded (disputed).` : ""}${p.ambiguous ? ` ${p.ambiguous} ambiguous for review.` : ""}`;
    actions.push({
      id: "slack.post_digest",
      kind: "slack.post_digest",
      provider: "slack",
      agent: "remediation-plan",
      gate: "auto",
      summary: { channel: input.financeChannel, mode: p.mode },
      async execute({ providers }) {
        const m = await providers.slack!.postMessage(input.financeChannel, text);
        return { ref: m.ts, detail: { channel: m.channel } };
      },
    });
    return actions;
  },

  output(_ctx, results) {
    const p = out<Plan>(results, "remediation-plan");
    if (!p) return { mode: "not decided" };
    return { mode: p.mode, reason: p.reason, refunds: p.totals.count, refundMinor: p.totals.amountMinor, autoMinor: p.totals.autoMinor, approvalMinor: p.totals.approvalMinor, excluded: p.excluded.length, ambiguous: p.ambiguous, notFound: p.notFound.length };
  },

  catalog: [
    { kind: "stripe.refund_duplicate", provider: "stripe", gate: "auto", description: "Refund one duplicate charge; approval above the single-refund or batch limit" },
    { kind: "gmail.draft_notice", provider: "gmail", gate: "auto", description: "Draft (not send) the customer notice, only after that customer's refunds went out" },
    { kind: "asana.remediation_record", provider: "asana", gate: "auto", description: "Remediation record for finance and audit" },
    { kind: "slack.post_digest", provider: "slack", gate: "auto", description: "Incident digest in the finance channel" },
  ],
};

function planFrom(results: AgentResults): Plan {
  const scan = out<Scan>(results, "charge-scan");
  const disputes = out<Disputes>(results, "dispute-check");
  const empty = { count: 0, amountMinor: 0, autoMinor: 0, approvalMinor: 0, currency: "usd" };
  const base = { refunds: [], excluded: [], ambiguous: 0, notFound: [] as string[], totals: empty };
  if (!scan) return { ...base, mode: "blocked", reason: results.status["charge-scan"] === "skipped" ? "Stripe not connected" : "payments could not be scanned" };
  const ambiguous = scan.customers.reduce((s, c) => s + c.ambiguous.length, 0);
  const notFound = scan.customers.filter((c) => !c.customerId).map((c) => c.email);
  const all = scan.customers.flatMap((c) => c.duplicates);
  // Fail closed: without the dispute list, nothing is refunded.
  if (!disputes) return { ...base, ambiguous, notFound, mode: "blocked", reason: "dispute status unknown, refunding nothing" };
  const disputed = new Set([...disputes.charges, ...disputes.paymentIntents]);
  const excluded = all.filter((d) => disputed.has(d.paymentIntent) || (d.charge && disputed.has(d.charge))).map((d) => ({ paymentIntent: d.paymentIntent, email: d.email, reason: "charge is disputed" }));
  const eligible = all.filter((d) => !excluded.some((x) => x.paymentIntent === d.paymentIntent));
  const currencies = new Set(eligible.map((d) => d.currency));
  if (currencies.size > 1) return { ...base, excluded, ambiguous, notFound, mode: "blocked", reason: `mixed currencies (${[...currencies].join(", ")}): run one incident per currency` };
  if (!eligible.length) return { ...base, excluded, ambiguous, notFound, mode: "nothing", reason: "no refundable duplicate charges" };
  const g = gateRefunds(eligible);
  const sum = (rs: Planned[]) => rs.reduce((s, r) => s + r.amountMinor, 0);
  const currency = eligible[0]!.currency;
  return {
    mode: g.mode,
    reason: g.reason,
    refunds: g.refunds,
    excluded,
    ambiguous,
    notFound,
    totals: { count: g.refunds.length, amountMinor: sum(g.refunds), autoMinor: sum(g.refunds.filter((r) => r.gate === "auto")), approvalMinor: sum(g.refunds.filter((r) => r.gate === "approval")), currency },
  };
}
