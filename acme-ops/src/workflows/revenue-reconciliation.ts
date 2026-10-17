import { z } from "zod";
import { LIVE_SUB_STATES, subscriptionMrr } from "../providers/stripe";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { Approvers, ChannelId, money, out, shortHash } from "./shared";

// Finance org · revops-finance team.
// Trigger: month-end close (or on demand). Reconciles three systems that each
// think they know who the customers are: Stripe (who pays), HubSpot (who sales
// says is a customer) and Zendesk (which refunds support approved).

const Input = z.object({
  financeChannel: ChannelId,
  /** Cap on CRM fixes proposed per run, so one bad sync can't flood the approver. */
  maxCrmFixes: z.number().int().min(0).max(100).default(25),
  /** Tag support puts on tickets whose refund was approved; refunds must quote the charge id in the ticket. */
  refundApprovalTag: z.string().min(1).default("refund-approved"),
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

interface StripeLedger {
  customers: { email: string; customerId: string; liveSubs: number; statuses: string[]; mrrMinor: number }[];
  refunds: { id: string; charge: string | null; amountMinor: number; currency: string }[];
  currency: string;
}
interface CrmLedger {
  customers: { email: string; contactId: string }[];
}
interface SupportLedger {
  approvedRefundText: string;
  tickets: number;
}

export type FindingKind = "crm_missing" | "billing_missing" | "refund_unapproved" | "past_due";
export interface Finding {
  kind: FindingKind;
  key: string;
  email?: string;
  detail: string;
  amountMinor?: number;
}

/** Pure reconciliation of the three ledgers. Exported for tests. */
export function reconcileLedgers(stripe: StripeLedger, crm: CrmLedger, support: SupportLedger | undefined): { findings: Finding[]; refundsUnverified: number; matched: number } {
  const findings: Finding[] = [];
  const crmByEmail = new Map(crm.customers.map((c) => [c.email, c]));
  const paying = stripe.customers.filter((c) => c.liveSubs > 0);
  const payingEmails = new Set(paying.map((c) => c.email));
  let matched = 0;
  for (const c of paying) {
    if (crmByEmail.has(c.email)) matched++;
    else findings.push({ kind: "crm_missing", key: c.email, email: c.email, detail: `pays ${money(c.mrrMinor, stripe.currency)}/mo in Stripe (${c.customerId}) but is not a HubSpot customer`, amountMinor: c.mrrMinor });
    if (c.statuses.includes("past_due") || c.statuses.includes("unpaid")) {
      findings.push({ kind: "past_due", key: c.email, email: c.email, detail: `subscription past due (${c.customerId})`, amountMinor: c.mrrMinor });
    }
  }
  for (const c of crm.customers) {
    if (!payingEmails.has(c.email)) findings.push({ kind: "billing_missing", key: c.email, email: c.email, detail: `HubSpot customer (${c.contactId}) with no live Stripe subscription` });
  }
  let refundsUnverified = 0;
  for (const r of stripe.refunds) {
    if (!support) {
      refundsUnverified++;
      continue;
    }
    const approved = (r.charge && support.approvedRefundText.includes(r.charge)) || support.approvedRefundText.includes(r.id);
    if (!approved) findings.push({ kind: "refund_unapproved", key: r.id, detail: `refund ${r.id} of ${money(r.amountMinor, r.currency)} on ${r.charge ?? "no charge"} has no approved Zendesk ticket`, amountMinor: r.amountMinor });
  }
  findings.sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
  return { findings, refundsUnverified, matched };
}

export const revenueReconciliation: WorkflowDef<Input> = {
  id: "revenue-reconciliation",
  title: "Revenue reconciliation",
  org: "Finance",
  team: "revops-finance",
  description:
    "Reconcile paying Stripe customers against HubSpot customers and Stripe refunds against Zendesk refund approvals; post the variance report to Finance and propose CRM fixes for approval.",
  input: Input,
  agents: [
    {
      name: "stripe-ledger",
      needs: ["stripe"],
      async run({ providers }) {
        const stripe = providers.stripe!;
        const [customers, subs, refunds] = await Promise.all([stripe.listCustomers(), stripe.listSubscriptions(), stripe.listRefunds()]);
        const byCustomer = new Map<string, typeof subs>();
        for (const s of subs) byCustomer.set(s.customer, [...(byCustomer.get(s.customer) ?? []), s]);
        // One row per email: duplicate Stripe customers for the same person are merged.
        const rows = new Map<string, StripeLedger["customers"][number]>();
        for (const c of customers) {
          if (!c.email) continue;
          const email = c.email.toLowerCase();
          const mine = byCustomer.get(c.id) ?? [];
          const live = mine.filter((s) => LIVE_SUB_STATES.has(s.status));
          const prev = rows.get(email);
          rows.set(email, {
            email,
            customerId: prev ? `${prev.customerId},${c.id}` : c.id,
            liveSubs: (prev?.liveSubs ?? 0) + live.length,
            statuses: [...(prev?.statuses ?? []), ...mine.map((s) => s.status)],
            mrrMinor: (prev?.mrrMinor ?? 0) + live.reduce((n, s) => n + subscriptionMrr(s), 0),
          });
        }
        const data: StripeLedger = {
          customers: [...rows.values()].sort((a, b) => a.email.localeCompare(b.email)),
          refunds: refunds.filter((r) => r.status === "succeeded").map((r) => ({ id: r.id, charge: r.charge, amountMinor: r.amount, currency: r.currency })),
          currency: subs[0]?.items.data[0]?.price?.currency ?? "usd",
        };
        return { summary: `${data.customers.length} customers, ${data.customers.filter((c) => c.liveSubs).length} paying, ${data.refunds.length} refunds`, data };
      },
    },
    {
      name: "crm-ledger",
      needs: ["hubspot"],
      async run({ providers }) {
        const contacts = await providers.hubspot!.searchEq("lifecyclestage", "customer");
        const data: CrmLedger = {
          customers: contacts
            .filter((c) => c.properties.email)
            .map((c) => ({ email: c.properties.email!.toLowerCase(), contactId: c.id }))
            .sort((a, b) => a.email.localeCompare(b.email)),
        };
        return { summary: `${data.customers.length} HubSpot customers`, data };
      },
    },
    {
      name: "support-ledger",
      needs: ["zendesk"],
      async run({ input, providers }) {
        const tickets = await providers.zendesk!.searchTickets(`tags:${input.refundApprovalTag}`, 1000);
        const data: SupportLedger = {
          tickets: tickets.length,
          approvedRefundText: tickets.map((t) => `${t.subject ?? ""} ${t.description ?? ""} ${(t.tags ?? []).join(" ")}`).join("\n"),
        };
        return { summary: `${tickets.length} approved-refund tickets`, data };
      },
    },
  ],

  plan({ input }, results) {
    const stripe = out<StripeLedger>(results, "stripe-ledger");
    const crm = out<CrmLedger>(results, "crm-ledger");
    // Reconciling against a ledger we couldn't read would report every row as a variance.
    if (!stripe || !crm) return [];
    const support = out<SupportLedger>(results, "support-ledger");
    const { findings, refundsUnverified, matched } = reconcileLedgers(stripe, crm, support);
    const count = (k: FindingKind) => findings.filter((f) => f.kind === k).length;
    const actions: PlannedAction<Input>[] = [];

    const lines = [
      `*Revenue reconciliation* — ${matched} matched, ${count("crm_missing")} paying-but-not-in-CRM, ${count("billing_missing")} CRM-customer-not-paying, ${count("past_due")} past due, ${count("refund_unapproved")} unapproved refund(s)${support ? "" : `, ${refundsUnverified} refund(s) unverified (Zendesk not connected)`}.`,
      ...findings.slice(0, 15).map((f) => `• ${f.kind}: ${f.detail}`),
      findings.length > 15 ? `…and ${findings.length - 15} more in the run output.` : "",
    ].filter(Boolean);
    actions.push({
      id: "slack.post_report",
      kind: "slack.post_report",
      provider: "slack",
      agent: "reconciler",
      gate: "auto",
      summary: { channel: input.financeChannel, findings: findings.length },
      async execute({ providers }) {
        const m = await providers.slack!.postMessage(input.financeChannel, lines.join("\n"));
        return { ref: m.ts, detail: { channel: m.channel } };
      },
    });

    for (const f of findings.filter((x) => x.kind === "crm_missing").slice(0, input.maxCrmFixes)) {
      const email = f.email!;
      actions.push({
        id: `hubspot.mark_customer:${shortHash(email)}`,
        kind: "hubspot.mark_customer",
        provider: "hubspot",
        agent: "reconciler",
        gate: "approval",
        summary: { email, set: { lifecyclestage: "customer" }, reason: f.detail },
        async execute({ providers }) {
          const { contact, created } = await providers.hubspot!.upsertByEmail(email, { lifecyclestage: "customer" });
          return { ref: contact.id, detail: { created } };
        },
        async reconcile({ providers }, receipt) {
          const c = await providers.hubspot!.get(receipt.ref);
          return c.properties.lifecyclestage === "customer" ? { status: "match" } : { status: "drift", detail: `lifecyclestage is ${c.properties.lifecyclestage}` };
        },
      });
    }
    return actions;
  },

  output(_ctx, results) {
    const stripe = out<StripeLedger>(results, "stripe-ledger");
    const crm = out<CrmLedger>(results, "crm-ledger");
    if (!stripe || !crm) return { reconciled: false, reason: "a required ledger could not be read" };
    const support = out<SupportLedger>(results, "support-ledger");
    const { findings, refundsUnverified, matched } = reconcileLedgers(stripe, crm, support);
    const count = (k: FindingKind) => findings.filter((f) => f.kind === k).length;
    return {
      reconciled: true,
      refundsVerified: !!support,
      totals: {
        stripePaying: stripe.customers.filter((c) => c.liveSubs > 0).length,
        crmCustomers: crm.customers.length,
        matched,
        crmMissing: count("crm_missing"),
        billingMissing: count("billing_missing"),
        pastDue: count("past_due"),
        refundsUnapproved: count("refund_unapproved"),
        refundsUnverified,
        mrrMinor: stripe.customers.reduce((n, c) => n + c.mrrMinor, 0),
      },
      findings,
    };
  },

  catalog: [
    { kind: "slack.post_report", provider: "slack", gate: "auto", description: "Post the variance report to the Finance channel" },
    { kind: "hubspot.mark_customer", provider: "hubspot", gate: "approval", description: "Create/update the HubSpot contact of a paying customer with lifecyclestage=customer" },
  ],
};
