import { z } from "zod";
import { FatalError, SkipAction } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { ChannelId, messageId, money, out } from "./shared";

// RevOps · billing-ops.
// Trigger: the quarter-end usage true-up. For each committed-use customer in
// scope, the contract (Stripe subscription metadata: committed units per
// quarter, overage price, billing contact) is compared with metered usage
// (Stripe billing meter event summaries) for the period. Overage becomes:
//   - a draft invoice with one overage line (idempotent per true-up and
//     customer); over the auto limit it waits for the account owner's approval;
//   - a notice to the billing contact (Gmail draft) with the breakdown;
//   - after a 7-day notice window the invoice is finalized and sent, unless
//     the account owner put it on hold (a dispute) during the window.
// Contracts missing a commitment or overage price are reported, never guessed;
// a meter that can't be read for a customer blocks only that customer.

export const POLICY = { autoInvoiceMax: 25_000_00, noticeDays: 7, daysUntilDue: 30, maxCustomers: 500 } as const;
const DAY = 86_400_000;

const Input = z.object({
  trueUpId: z.string().regex(/^TU-[\w-]{3,40}$/, "true-up id like TU-2026-Q3"),
  /** Stripe billing meter id (opaque; Stripe issues mtr_…). */
  meterId: z.string().regex(/^[\w-]{3,255}$/),
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  customers: z.array(z.string().regex(/^cus_\w+$/)).min(1).max(POLICY.maxCustomers),
  revopsChannel: ChannelId,
  /** Stripe customer → account owner's Slack id (may hold an invoice). */
  owners: z.record(z.string(), z.string().regex(/^U[A-Z0-9_]+$/)).default({}),
  billingLeads: z.array(z.string()).min(1),
});
type Input = z.infer<typeof Input>;

export interface Contract {
  customer: string;
  committed: number | null;
  overagePrice: string | null;
  unitAmount: number | null;
  currency: string;
  billingEmail: string | null;
}
export interface Line {
  customer: string;
  usage: number | null;
  committed: number | null;
  overageUnits: number;
  amount: number;
  problem: string | null;
}

/** Pure: what each customer owes over its commitment. */
export function trueUp(c: Contract, usage: number | null): Line {
  const base = { customer: c.customer, usage, committed: c.committed, overageUnits: 0, amount: 0 };
  if (usage === null) return { ...base, problem: "usage could not be read" };
  if (c.committed === null || !c.overagePrice || c.unitAmount === null) return { ...base, problem: "contract has no commitment or overage price" };
  if (!c.billingEmail) return { ...base, problem: "no billing contact" };
  const overageUnits = Math.max(0, Math.ceil(usage - c.committed));
  return { ...base, overageUnits, amount: overageUnits * c.unitAmount, problem: null };
}

const sec = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);

export const usageTrueUp: WorkflowDef<Input> = {
  id: "usage-true-up",
  title: "Usage true-up (committed use)",
  org: "RevOps",
  team: "billing-ops",
  description:
    "Compare each committed-use customer's metered usage with its contract, draft an overage invoice once per true-up (approval over the limit), notify the billing contact, and finalize after a 7-day notice window unless the account owner holds it; incomplete contracts or unreadable usage are reported, never guessed.",
  input: Input,
  audit: true,
  tickEvery: "rate(1 hour)",
  agents: [
    {
      name: "contracts",
      needs: ["stripe"],
      async run({ input, providers, checkpoint }) {
        const stripe = providers.stripe!;
        const done = (await checkpoint.load<Record<string, Contract>>("contracts")) ?? {};
        for (const cus of input.customers) {
          if (done[cus]) continue;
          const c = await stripe.getCustomer(cus);
          const sub = (await stripe.listSubscriptions(cus)).find((s) => s.customer === cus && s.metadata?.acme_committed_units);
          const price = sub?.metadata?.acme_overage_price ? await stripe.getPrice(sub.metadata.acme_overage_price) : null;
          done[cus] = { customer: cus, committed: sub ? Number(sub.metadata!.acme_committed_units) : null, overagePrice: price?.id ?? null, unitAmount: price?.unit_amount ?? null, currency: price?.currency ?? "usd", billingEmail: sub?.metadata?.acme_billing_email ?? c.email ?? null };
          await checkpoint.save("contracts", done);
        }
        return { summary: `${Object.keys(done).length} contract(s)`, data: Object.values(done) };
      },
    },
    {
      name: "usage",
      needs: ["stripe"],
      async run({ input, providers }) {
        const usage: Record<string, number | null> = {};
        for (const cus of input.customers) {
          try {
            usage[cus] = await providers.stripe!.meterUsage(input.meterId, cus, sec(input.periodStart), sec(input.periodEnd));
          } catch {
            usage[cus] = null;
          }
        }
        const unread = Object.values(usage).filter((v) => v === null).length;
        if (unread === input.customers.length) throw new FatalError("the meter could not be read for any customer");
        return { summary: `usage for ${input.customers.length - unread} customer(s)${unread ? `, ${unread} unreadable` : ""}: ${Object.entries(usage).map(([c, u]) => `${c}=${u ?? "?"}`).join(", ").slice(0, 300)}`, data: usage };
      },
    },
  ],

  compose: {
    name: "true-up",
    async run(_ctx, results) {
      const contracts = out<Contract[]>(results, "contracts");
      const usage = out<Record<string, number | null>>(results, "usage");
      if (!contracts || !usage) throw new FatalError("contracts or usage unavailable");
      const lines = contracts.map((c) => trueUp(c, usage[c.customer] ?? null));
      const owed = lines.filter((l) => l.amount > 0);
      return { summary: `${owed.length} customer(s) over commitment, ${lines.filter((l) => l.problem).length} problem(s)`, data: { lines, contracts } };
    },
  },

  plan({ input, startedAt }, results) {
    const t = out<{ lines: Line[]; contracts: Contract[] }>(results, "true-up");
    const actions: PlannedAction<Input>[] = [];
    if (!t) {
      return [
        {
          id: "slack.post_true_up",
          kind: "slack.post_true_up",
          provider: "slack",
          agent: "usage",
          gate: "auto",
          summary: { blocked: true },
          async execute({ providers }) {
            return { ref: (await providers.slack!.postMessage(input.revopsChannel, `:warning: ${input.trueUpId}: contracts or usage could not be read; nothing invoiced.`)).ts };
          },
        },
      ];
    }
    const noticeEnds = new Date(startedAt.getTime() + POLICY.noticeDays * DAY).toISOString();
    for (const l of t.lines.filter((x) => x.amount > 0)) {
      const c = t.contracts.find((x) => x.customer === l.customer)!;
      const draft = `stripe.draft_overage:${l.customer}`;
      const amount = money(l.amount, c.currency);
      actions.push({
        id: draft,
        kind: "stripe.draft_overage",
        provider: "stripe",
        agent: "true-up",
        gate: l.amount > POLICY.autoInvoiceMax ? "approval" : "auto",
        summary: { customer: l.customer, usage: l.usage, committed: l.committed, overageUnits: l.overageUnits, amount },
        async execute({ providers }) {
          const stripe = providers.stripe!;
          // An invoice for this true-up already exists (e.g. created before a crash): reuse it.
          const existing = (await stripe.listInvoices(l.customer)).find((i) => i.customer === l.customer && i.metadata?.acme_true_up === input.trueUpId);
          if (existing) return { ref: existing.id, detail: { reused: true } };
          const inv = await stripe.createDraftInvoice(l.customer, `Usage true-up ${input.periodStart} to ${input.periodEnd}`, POLICY.daysUntilDue, { acme_true_up: input.trueUpId }, `${input.trueUpId}:${l.customer}:invoice`);
          await stripe.addInvoiceLine(inv.id, l.customer, c.overagePrice!, l.overageUnits, `${l.overageUnits} units over the ${l.committed}-unit commitment (${l.usage} used)`, `${input.trueUpId}:${l.customer}:line`);
          return { ref: inv.id };
        },
      });
      actions.push({
        id: `gmail.notice:${l.customer}`,
        kind: "gmail.notice",
        provider: "gmail",
        agent: "true-up",
        gate: "auto",
        summary: { customer: l.customer, amount, sent: false },
        requires: [draft],
        async execute({ providers, runId }) {
          const d = await providers.gmail!.createDraft({
            to: c.billingEmail!,
            subject: `Usage true-up for ${input.periodStart} to ${input.periodEnd}`,
            body: `Hello,\n\nYour plan includes ${l.committed} units for this period and ${l.usage} were used, so ${l.overageUnits} units are billed at the contracted overage rate: ${amount}.\n\nThe invoice will be issued on ${noticeEnds.slice(0, 10)}. Reply before then if anything looks wrong.\n\nACME Billing`,
            messageId: messageId(runId, `true-up-${l.customer}`),
          });
          return { ref: d.id };
        },
      });
      const owner = input.owners[l.customer];
      actions.push({
        id: `stripe.issue:${l.customer}`,
        kind: "stripe.issue",
        provider: "stripe",
        agent: "true-up",
        gate: "auto",
        summary: { customer: l.customer, amount, meaning: "reject = hold the invoice (customer dispute); silence issues it" },
        awaitSignal: { from: [...(owner ? [owner] : []), ...input.billingLeads], deadline: noticeEnds, onDeadline: "approve" },
        requires: [draft, `gmail.notice:${l.customer}`],
        async execute({ providers, applied }) {
          const stripe = providers.stripe!;
          const inv = await stripe.getInvoice(applied[draft]!.ref);
          if (inv.status !== "draft") throw new SkipAction(`invoice is ${inv.status}`);
          await stripe.finalizeInvoice(inv.id);
          const sent = await stripe.sendInvoice(inv.id);
          return { ref: sent.id, detail: { status: sent.status } };
        },
      });
    }
    const problems = t.lines.filter((l) => l.problem);
    const owed = t.lines.filter((l) => l.amount > 0);
    actions.push({
      id: "slack.post_true_up",
      kind: "slack.post_true_up",
      provider: "slack",
      agent: "true-up",
      gate: "auto",
      summary: { owed: owed.length, problems: problems.length },
      async execute({ providers }) {
        const text = [
          `:bar_chart: ${input.trueUpId}: ${owed.length} of ${t.lines.length} customer(s) over commitment; invoices issue ${noticeEnds.slice(0, 10)} unless held.`,
          ...problems.slice(0, 10).map((p) => `• ${p.customer}: ${p.problem}`),
        ];
        return { ref: (await providers.slack!.postMessage(input.revopsChannel, text.join("\n"))).ts };
      },
    });
    return actions;
  },

  output(_ctx, results) {
    const t = out<{ lines: Line[] }>(results, "true-up");
    if (!t) return { mode: "blocked" };
    return { mode: "true_up", customers: t.lines.length, owed: t.lines.filter((l) => l.amount > 0).length, problems: t.lines.filter((l) => l.problem).length, totalOverage: t.lines.reduce((s, l) => s + l.amount, 0) };
  },

  catalog: [
    { kind: "stripe.draft_overage", provider: "stripe", gate: "auto", description: "Draft overage invoice, once per true-up; approval over 25,000" },
    { kind: "gmail.notice", provider: "gmail", gate: "auto", description: "Breakdown to the billing contact (draft)" },
    { kind: "stripe.issue", provider: "stripe", gate: "auto", description: "Signal: finalize and send after the notice window unless held" },
    { kind: "slack.post_true_up", provider: "slack", gate: "auto", description: "Summary with contracts that couldn't be trued up" },
  ],
};
