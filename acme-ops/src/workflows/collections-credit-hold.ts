import { z } from "zod";
import { stripeTime } from "../providers/stripe";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { Approvers, ChannelId, messageId, money, out, shortHash } from "./shared";

// Finance org · ar-collections team.
// Trigger: daily AR schedule. Open Stripe invoices past due are tiered by age;
// reminders are drafted, the AR channel gets a digest, and the worst accounts
// are proposed for credit hold (approval required).

const Input = z.object({
  arChannel: ChannelId,
  /** Evaluation date (YYYY-MM-DD); defaults to the run's start. Lets a schedule replay a given day. */
  asOf: z.iso.date().optional(),
  minDaysOverdue: z.number().int().min(1).max(365).default(7),
  /** Accounts this many days overdue (or more) are proposed for credit hold. */
  holdAfterDays: z.number().int().min(1).max(365).default(60),
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

export type Tier = "reminder" | "firm" | "final";
export interface Overdue {
  invoiceId: string;
  number?: string | null;
  customerId: string;
  email?: string | null;
  name?: string | null;
  amountMinor: number;
  currency: string;
  daysOverdue: number;
  tier: Tier;
  disputed: boolean;
  onHold: boolean;
}
interface Owners {
  byEmail: Record<string, { contactId: string; owner?: string; company?: string }>;
}

export function tierFor(days: number): Tier {
  return days >= 60 ? "final" : days >= 30 ? "firm" : "reminder";
}

const truthy = (v: string | undefined) => v === "true" || v === "1" || v === "yes";

const TEMPLATES: Record<Tier, (o: Overdue) => { subject: string; body: string }> = {
  reminder: (o) => ({
    subject: `Friendly reminder: invoice ${o.number ?? o.invoiceId}`,
    body: `Hello,\n\nOur records show invoice ${o.number ?? o.invoiceId} for ${money(o.amountMinor, o.currency)} is ${o.daysOverdue} days past due. If it's already on its way, thank you. Otherwise please let us know when we can expect payment.\n\nACME Accounts Receivable`,
  }),
  firm: (o) => ({
    subject: `Second notice: invoice ${o.number ?? o.invoiceId} is ${o.daysOverdue} days past due`,
    body: `Hello,\n\nInvoice ${o.number ?? o.invoiceId} for ${money(o.amountMinor, o.currency)} remains unpaid ${o.daysOverdue} days after its due date. Please arrange payment or reply with the expected date so we can update our records.\n\nACME Accounts Receivable`,
  }),
  final: (o) => ({
    subject: `Final notice: invoice ${o.number ?? o.invoiceId}`,
    body: `Hello,\n\nInvoice ${o.number ?? o.invoiceId} for ${money(o.amountMinor, o.currency)} is ${o.daysOverdue} days past due. Without payment or a payment plan, new orders on this account may be placed on hold. Please contact us to resolve it.\n\nACME Accounts Receivable`,
  }),
};

export const collectionsCreditHold: WorkflowDef<Input> = {
  id: "collections-credit-hold",
  title: "Collections and credit hold",
  org: "Finance",
  team: "ar-collections",
  description:
    "Tier open, past-due Stripe invoices by age; draft reminders, post the AR digest, and propose a credit hold for the most overdue accounts. Holds wait for approval; disputed invoices are never held.",
  input: Input,
  agents: [
    {
      name: "ar-ledger",
      needs: ["stripe"],
      async run({ input, providers, startedAt }) {
        const stripe = providers.stripe!;
        const now = input.asOf ? Date.parse(`${input.asOf}T00:00:00Z`) : startedAt.getTime();
        const [invoices, customers] = await Promise.all([stripe.listInvoices(undefined, "open"), stripe.listCustomers()]);
        const byId = new Map(customers.map((c) => [c.id, c]));
        const overdue: Overdue[] = [];
        for (const inv of invoices) {
          if (inv.status !== "open" || !(inv.amount_remaining > 0)) continue;
          const due = stripeTime(inv.due_date);
          if (due === undefined) continue;
          const days = Math.floor((now - due) / 86_400_000);
          if (days < input.minDaysOverdue) continue;
          const c = byId.get(inv.customer);
          overdue.push({
            invoiceId: inv.id,
            number: inv.number,
            customerId: inv.customer,
            email: c?.email?.toLowerCase() ?? null,
            name: c?.name ?? null,
            amountMinor: inv.amount_remaining,
            currency: inv.currency ?? "usd",
            daysOverdue: days,
            tier: tierFor(days),
            disputed: truthy(inv.metadata?.disputed) || truthy(c?.metadata?.dispute),
            onHold: truthy(c?.metadata?.credit_hold),
          });
        }
        overdue.sort((a, b) => b.daysOverdue - a.daysOverdue || a.invoiceId.localeCompare(b.invoiceId));
        return { summary: `${overdue.length} past-due invoice(s), ${money(overdue.reduce((n, o) => n + o.amountMinor, 0))} outstanding`, data: { overdue } };
      },
    },
    {
      name: "account-owners",
      needs: ["hubspot", "stripe"],
      async run({ providers }) {
        // Owners are looked up for every customer with an open invoice; cheap and keeps agents independent.
        const invoices = await providers.stripe!.listInvoices(undefined, "open");
        const customers = await providers.stripe!.listCustomers();
        const emails = [...new Set(invoices.map((i) => customers.find((c) => c.id === i.customer)?.email?.toLowerCase()).filter(Boolean) as string[])].sort();
        const byEmail: Owners["byEmail"] = {};
        for (const email of emails) {
          const c = await providers.hubspot!.findByEmail(email);
          if (c) byEmail[email] = { contactId: c.id, owner: c.properties.hubspot_owner_id ?? undefined, company: c.properties.company ?? undefined };
        }
        return { summary: `${Object.keys(byEmail).length}/${emails.length} account(s) in HubSpot`, data: { byEmail } satisfies Owners };
      },
    },
  ],

  plan({ input }, results) {
    const ledger = out<{ overdue: Overdue[] }>(results, "ar-ledger");
    if (!ledger) return [];
    const owners = out<Owners>(results, "account-owners")?.byEmail ?? {};
    const actions: PlannedAction<Input>[] = [];
    if (!ledger.overdue.length) return actions;

    const lines = [
      `*AR collections* — ${ledger.overdue.length} past-due invoice(s), ${money(ledger.overdue.reduce((n, o) => n + o.amountMinor, 0))} outstanding.`,
      ...ledger.overdue
        .slice(0, 20)
        .map((o) => `• ${o.tier.toUpperCase()} ${o.email ?? o.customerId} ${o.invoiceId} ${money(o.amountMinor, o.currency)} · ${o.daysOverdue}d${o.disputed ? " · disputed, no hold" : ""}${o.onHold ? " · already on hold" : ""}${owners[o.email ?? ""]?.owner ? ` · owner ${owners[o.email!]!.owner}` : ""}`),
    ];
    actions.push({
      id: "slack.post_ar_digest",
      kind: "slack.post_ar_digest",
      provider: "slack",
      agent: "ar-ledger",
      gate: "auto",
      summary: { channel: input.arChannel, invoices: ledger.overdue.length },
      async execute({ providers }) {
        const m = await providers.slack!.postMessage(input.arChannel, lines.join("\n"));
        return { ref: m.ts, detail: { channel: m.channel } };
      },
    });

    for (const o of ledger.overdue) {
      if (!o.email || o.disputed) continue;
      const key = shortHash(o.invoiceId);
      const draft = TEMPLATES[o.tier](o);
      actions.push({
        id: `gmail.draft_reminder:${key}`,
        kind: "gmail.draft_reminder",
        provider: "gmail",
        agent: "ar-ledger",
        gate: "auto",
        summary: { to: o.email, invoiceId: o.invoiceId, tier: o.tier, sent: false },
        async execute({ providers, runId }) {
          const d = await providers.gmail!.createDraft({ to: o.email!, subject: draft.subject, body: draft.body, messageId: messageId(runId, `ar-${key}`) });
          return { ref: d.id };
        },
      });
    }

    // One hold per customer, for the oldest qualifying invoice.
    const held = new Set<string>();
    for (const o of ledger.overdue) {
      if (o.daysOverdue < input.holdAfterDays || o.disputed || o.onHold || held.has(o.customerId)) continue;
      held.add(o.customerId);
      actions.push({
        id: `stripe.credit_hold:${shortHash(o.customerId)}`,
        kind: "stripe.credit_hold",
        provider: "stripe",
        agent: "ar-ledger",
        gate: "approval",
        summary: { customerId: o.customerId, email: o.email, invoiceId: o.invoiceId, daysOverdue: o.daysOverdue, outstanding: money(o.amountMinor, o.currency) },
        async execute({ providers, runId }) {
          const c = await providers.stripe!.updateCustomerMetadata(o.customerId, { credit_hold: "true", credit_hold_invoice: o.invoiceId, credit_hold_run: runId });
          return { ref: c.id };
        },
        async reconcile({ providers }, receipt) {
          const c = await providers.stripe!.getCustomer(receipt.ref);
          return c.metadata?.credit_hold === "true" ? { status: "match" } : { status: "drift", detail: `credit_hold is ${c.metadata?.credit_hold ?? "unset"}` };
        },
      });
    }
    return actions;
  },

  output(_ctx, results) {
    const ledger = out<{ overdue: Overdue[] }>(results, "ar-ledger");
    if (!ledger) return { evaluated: false };
    const o = ledger.overdue;
    return {
      evaluated: true,
      pastDue: o.length,
      outstandingMinor: o.reduce((n, x) => n + x.amountMinor, 0),
      byTier: { reminder: o.filter((x) => x.tier === "reminder").length, firm: o.filter((x) => x.tier === "firm").length, final: o.filter((x) => x.tier === "final").length },
      disputed: o.filter((x) => x.disputed).length,
      invoices: o,
    };
  },

  catalog: [
    { kind: "slack.post_ar_digest", provider: "slack", gate: "auto", description: "Post the past-due digest to the AR channel" },
    { kind: "gmail.draft_reminder", provider: "gmail", gate: "auto", description: "Create (not send) a tiered reminder draft per past-due invoice" },
    { kind: "stripe.credit_hold", provider: "stripe", gate: "approval", description: "Put the account on credit hold (Stripe customer metadata credit_hold=true)" },
  ],
};
