import { z } from "zod";
import { SkipAction } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { Approvers, ChannelId, money, out } from "./shared";

// Finance · controllership.
// Trigger: the first business day after period end. The close is a multi-day
// checklist with deadlines (Kit v2 timers and signals):
//   1. reconcile Stripe payouts with bank deposits (Plaid), matching amount
//      and arrival date within three days; anything unmatched becomes an
//      exception task;
//   2. propose two journal entries: Stripe fees (expense / clearing) and the
//      received-not-billed accrual (auto-reversing on the first day of the next
//      period); each posts only after a controller approves it;
//   3. remind on day 2 while journals are open;
//   4. a controller signs off once both journals are settled, and the period
//      is locked in the ERP. Nothing locks without the sign-off.
// Journals carry an external id per period, so a retry never posts twice.

export const POLICY = {
  matchDays: 3,
  journalDays: 3,
  signoffDays: 5,
  reminderDay: 2,
  accounts: { stripeFees: "6150", stripeClearing: "1105", accruedLiabilities: "2150", cogsAccrual: "5010" },
} as const;

const Input = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM"),
  /** NetSuite accounting period name, e.g. "Oct 2026". */
  periodName: z.string().min(3).max(40),
  /** Plaid access token of the operating account Stripe pays out to. */
  bankAccessToken: z.string().regex(/^access-[\w-]{6,120}$/),
  closeChannel: ChannelId,
  closeWorkspace: z.string().min(1).default("acme-close"),
  /** Controllers: approve journals and sign off. */
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

export interface Payout {
  id: string;
  amountMinor: number;
  arrival: string;
  feesMinor: number;
}
export interface Deposit {
  id: string;
  amountMinor: number;
  date: string;
}
export interface Recon {
  matched: { payout: string; deposit: string }[];
  unmatchedPayouts: Payout[];
  unmatchedDeposits: Deposit[];
  feesMinor: number;
}

const DAY = 86_400_000;

/** Payout ↔ deposit matching: same amount, arrival within POLICY.matchDays, one-to-one. Pure. */
export function reconcile(payouts: Payout[], deposits: Deposit[]): Recon {
  const free = [...deposits].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const matched: Recon["matched"] = [];
  const unmatchedPayouts: Payout[] = [];
  for (const p of [...payouts].sort((a, b) => a.arrival.localeCompare(b.arrival) || a.id.localeCompare(b.id))) {
    const i = free.findIndex((d) => d.amountMinor === p.amountMinor && Math.abs(Date.parse(d.date) - Date.parse(p.arrival)) <= POLICY.matchDays * DAY);
    if (i < 0) unmatchedPayouts.push(p);
    else matched.push({ payout: p.id, deposit: free.splice(i, 1)[0]!.id });
  }
  return { matched, unmatchedPayouts, unmatchedDeposits: free, feesMinor: payouts.reduce((s, p) => s + p.feesMinor, 0) };
}

export function periodBounds(period: string): { start: string; end: string; next: string } {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1, 1));
  const next = new Date(Date.UTC(y, m, 1));
  const end = new Date(next.getTime() - DAY);
  const d = (x: Date) => x.toISOString().slice(0, 10);
  return { start: d(start), end: d(end), next: d(next) };
}

export const monthEndClose: WorkflowDef<Input> = {
  id: "month-end-close",
  title: "Month-end close",
  org: "Finance",
  team: "controllership",
  description:
    "Run the month-end close: reconcile Stripe payouts with bank deposits, propose the Stripe-fee and received-not-billed accrual journals (posted only on a controller's approval, accrual auto-reversing), remind while open, and lock the period only after the controller signs off.",
  input: Input,
  audit: true,
  tickEvery: "rate(1 hour)",
  agents: [
    {
      name: "stripe-payouts",
      needs: ["stripe"],
      async run({ input, providers }) {
        const b = periodBounds(input.period);
        const payouts = (await providers.stripe!.listPayouts(Date.parse(b.start) / 1000, Date.parse(b.next) / 1000)).filter((p) => p.status === "paid");
        const data: Payout[] = [];
        for (const p of payouts) {
          const txns = await providers.stripe!.payoutTransactions(p.id);
          data.push({ id: p.id, amountMinor: p.amount, arrival: new Date(p.arrival_date * 1000).toISOString().slice(0, 10), feesMinor: txns.reduce((s, t) => s + (t.fee ?? 0), 0) });
        }
        return { summary: `${data.length} payout(s), ${money(data.reduce((s, p) => s + p.amountMinor, 0), "usd")}`, data };
      },
    },
    {
      name: "bank-deposits",
      needs: ["plaid"],
      async run({ input, providers }) {
        const b = periodBounds(input.period);
        // Payouts landing in the first days of the next month still belong to this period's reconciliation.
        const until = new Date(Date.parse(b.next) + POLICY.matchDays * DAY).toISOString().slice(0, 10);
        const txns = await providers.plaid!.transactions(input.bankAccessToken, b.start, until);
        const data: Deposit[] = txns.filter((t) => t.amount < 0 && /stripe/i.test(t.name)).map((t) => ({ id: t.transaction_id, amountMinor: Math.round(-t.amount * 100), date: t.date }));
        return { summary: `${data.length} Stripe deposit(s)`, data };
      },
    },
    {
      name: "unbilled-receipts",
      needs: ["netsuite"],
      async run({ input, providers }) {
        const b = periodBounds(input.period);
        const rows = await providers.netsuite!.suiteql<{ amount: string | number }>(`SELECT SUM(foreignamount) AS amount FROM transactionline WHERE transaction IN (SELECT id FROM transaction WHERE type = 'ItemRcpt' AND trandate <= TO_DATE('${b.end}', 'YYYY-MM-DD')) AND isbilled = 'F'`);
        const amountMinor = Math.round(Number(rows[0]?.amount ?? 0) * 100);
        return { summary: `received not billed ${money(amountMinor, "usd")}`, data: { amountMinor } };
      },
    },
  ],

  compose: {
    name: "close-plan",
    async run(_ctx, results) {
      const payouts = out<Payout[]>(results, "stripe-payouts");
      const deposits = out<Deposit[]>(results, "bank-deposits");
      const recon = payouts && deposits ? reconcile(payouts, deposits) : null;
      return { summary: recon ? `${recon.matched.length} matched, ${recon.unmatchedPayouts.length + recon.unmatchedDeposits.length} exception(s)` : "reconciliation blocked", data: { recon, accrualMinor: out<{ amountMinor: number }>(results, "unbilled-receipts")?.amountMinor ?? null } };
    },
  },

  plan({ input, startedAt }, results) {
    const p = out<{ recon: Recon | null; accrualMinor: number | null }>(results, "close-plan");
    if (!p) return [];
    const b = periodBounds(input.period);
    const at = (days: number) => new Date(startedAt.getTime() + days * DAY).toISOString();
    const ids = { fees: `netsuite.journal:fees:${input.period}`, accrual: `netsuite.journal:accrual:${input.period}`, signoff: `controller.signoff:${input.period}`, lock: `netsuite.lock_period:${input.period}` };
    const actions: PlannedAction<Input>[] = [];
    const approvers = input.approvers ?? [];
    const journal = (id: string, kind: string, amountMinor: number, debit: string, credit: string, memo: string, reversal?: string): PlannedAction<Input> => ({
      id,
      kind: "netsuite.journal",
      provider: "netsuite",
      agent: "close-plan",
      gate: "auto",
      summary: { journal: kind, amount: money(amountMinor, "usd"), debit, credit, reversal: reversal ?? null },
      awaitSignal: { from: approvers, deadline: at(POLICY.journalDays), onDeadline: "reject" },
      async execute({ providers, signal }) {
        const externalId = `close-${input.period}-${kind}`;
        const prior = await providers.netsuite!.findJournal(externalId);
        if (prior) return { ref: prior.id, detail: { reused: true } };
        const amount = amountMinor / 100;
        const j = await providers.netsuite!.createJournal({ externalId, tranDate: b.end, memo, reversalDate: reversal, lines: [{ account: debit, debit: amount, memo }, { account: credit, credit: amount, memo }] });
        return { ref: j.id, detail: { approvedBy: signal?.by } };
      },
    });

    // A close that can't reconcile cash or read receipts proposes nothing: it only says why.
    const blocked = !p.recon || p.accrualMinor === null;
    if (blocked) {
      return [
        {
          id: `slack.close_status:${input.period}`,
          kind: "slack.close_status",
          provider: "slack",
          agent: "close-plan",
          gate: "auto",
          summary: { channel: input.closeChannel, blocked: true },
          async execute({ providers }) {
            const m = await providers.slack!.postMessage(input.closeChannel, `:rotating_light: ${input.period} close blocked: ${!p.recon ? "payouts or bank transactions could not be read" : "unbilled receipts could not be read"}.`);
            return { ref: m.ts };
          },
        },
      ];
    }
    if (p.recon) {
      if (p.recon.feesMinor > 0) actions.push(journal(ids.fees, "fees", p.recon.feesMinor, POLICY.accounts.stripeFees, POLICY.accounts.stripeClearing, `Stripe fees ${input.period}`));
      const exceptions = [...p.recon.unmatchedPayouts.map((x) => `payout ${x.id} ${money(x.amountMinor, "usd")} (${x.arrival}) has no bank deposit`), ...p.recon.unmatchedDeposits.map((x) => `deposit ${x.id} ${money(x.amountMinor, "usd")} (${x.date}) has no Stripe payout`)];
      if (exceptions.length) {
        actions.push({
          id: `asana.recon_exceptions:${input.period}`,
          kind: "asana.recon_exceptions",
          provider: "asana",
          agent: "close-plan",
          gate: "auto",
          summary: { exceptions: exceptions.length },
          async execute({ providers }) {
            const t = await providers.asana!.createTask({ name: `${input.period} close: ${exceptions.length} cash reconciliation exception(s)`, notes: exceptions.join("\n"), workspace: input.closeWorkspace, due_on: at(POLICY.journalDays).slice(0, 10) });
            return { ref: t.gid };
          },
        });
      }
    }
    if (p.accrualMinor && p.accrualMinor > 0) actions.push(journal(ids.accrual, "accrual", p.accrualMinor, POLICY.accounts.cogsAccrual, POLICY.accounts.accruedLiabilities, `Received not billed ${input.period}`, b.next));
    const journalIds = [ids.fees, ids.accrual].filter((id) => actions.some((a) => a.id === id));

    if (journalIds.length) actions.push({
      id: `slack.remind:${input.period}`,
      kind: "slack.remind",
      provider: "slack",
      agent: "close-plan",
      gate: "auto",
      summary: { day: POLICY.reminderDay },
      waitUntil: at(POLICY.reminderDay),
      async execute({ providers, statuses }) {
        const open = journalIds.filter((id) => statuses[id] === "awaiting_signal");
        if (!open.length) throw new SkipAction("no journals waiting");
        const m = await providers.slack!.postMessage(input.closeChannel, `:hourglass: ${input.period} close: ${open.length} journal(s) await controller approval; due ${at(POLICY.journalDays).slice(0, 10)}.`);
        return { ref: m.ts };
      },
    });

    actions.push({
      id: ids.signoff,
      kind: "controller.signoff",
      provider: "netsuite",
      agent: "close-plan",
      gate: "auto",
      summary: { period: input.period, meaning: "approve = sign off and lock the period" },
      awaitSignal: { from: approvers, deadline: at(POLICY.signoffDays), onDeadline: "reject" },
      after: journalIds,
      async execute({ signal }) {
        return { ref: input.period, detail: { signedOffBy: signal?.by } };
      },
    });
    actions.push({
      id: ids.lock,
      kind: "netsuite.lock_period",
      provider: "netsuite",
      agent: "close-plan",
      gate: "auto",
      summary: { period: input.periodName },
      requires: [ids.signoff],
      async execute({ providers }) {
        const r = await providers.netsuite!.lockPeriod(input.periodName);
        return { ref: r.id };
      },
    });
    actions.push({
      id: `slack.close_status:${input.period}`,
      kind: "slack.close_status",
      provider: "slack",
      agent: "close-plan",
      gate: "auto",
      summary: { channel: input.closeChannel },
      after: [ids.lock],
      async execute({ providers, statuses }) {
        const text =
          statuses[ids.lock] === "applied"
            ? `:lock: ${input.period} closed and locked (${p.recon!.matched.length} payouts reconciled).`
            : `:warning: ${input.period} NOT locked: sign-off ${statuses[ids.signoff]}.`;
        const m = await providers.slack!.postMessage(input.closeChannel, text);
        return { ref: m.ts };
      },
    });
    return actions;
  },

  output(_ctx, results) {
    const p = out<{ recon: Recon | null; accrualMinor: number | null }>(results, "close-plan");
    if (!p) return { mode: "not decided" };
    return { mode: p.recon && p.accrualMinor !== null ? "closing" : "blocked", matched: p.recon?.matched.length ?? 0, exceptions: p.recon ? p.recon.unmatchedPayouts.length + p.recon.unmatchedDeposits.length : null, feesMinor: p.recon?.feesMinor ?? null, accrualMinor: p.accrualMinor };
  },

  catalog: [
    { kind: "netsuite.journal", provider: "netsuite", gate: "auto", description: "Proposed journal (Stripe fees, received-not-billed accrual with reversal), posted on a controller's approval" },
    { kind: "asana.recon_exceptions", provider: "asana", gate: "auto", description: "Unmatched payouts and deposits as an exception task" },
    { kind: "slack.remind", provider: "slack", gate: "auto", description: "Day-2 reminder while journals wait" },
    { kind: "controller.signoff", provider: "netsuite", gate: "auto", description: "Signal: the controller signs off once journals are settled" },
    { kind: "netsuite.lock_period", provider: "netsuite", gate: "auto", description: "Lock the accounting period, only after sign-off" },
    { kind: "slack.close_status", provider: "slack", gate: "auto", description: "Close outcome" },
  ],
};
