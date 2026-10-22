import { z } from "zod";
import { FatalError, SkipAction } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { ChannelId, money, out } from "./shared";

// Finance · treasury.
// Trigger: an outbound wire or ACH payment entered by a treasury analyst (the
// maker). Checked in parallel: the beneficiary account (verified, not added in
// the last 30 days without verification), sanctions screening of the
// counterparty, possible duplicates (same account and amount within 7 days) and
// the originating account's daily outflow limit. Then dual control:
//   - a treasury approver who isn't the maker (checker);
//   - over 100,000 also the CFO, who isn't the maker or the checker.
// Approvals must land before the rail's cut-off on the value date, otherwise
// the payment lapses (it would miss its value date). Release creates the
// Modern Treasury payment order with the payment id as idempotency key and
// metadata (looked up first, so a retry never pays twice). The day after
// release the order is re-read: returned or failed payments are escalated.

export const POLICY = { cfoOver: 100_000_00, newBeneficiaryDays: 30, duplicateWindowDays: 7, cutoffUtc: { wire: "21:00", ach: "19:00" } } as const;
const DAY = 86_400_000;

const Input = z.object({
  paymentId: z.string().regex(/^PAY-[\w-]{3,40}$/, "payment id like PAY-2026-0042"),
  type: z.enum(["wire", "ach"]),
  /** Minor units. */
  amount: z.number().int().positive().max(50_000_000_00),
  currency: z.enum(["usd"]),
  originatingAccountId: z.string().min(3).max(64),
  receivingAccountId: z.string().min(3).max(64),
  purpose: z.string().min(3).max(140),
  valueDate: z.iso.date(),
  maker: z.string().regex(/^U[A-Z0-9_]+$/),
  approvers: z.object({ treasury: z.array(z.string()).min(1), cfo: z.array(z.string()).min(1) }),
  /** Maximum total sent from the originating account per value date. */
  dailyLimit: z.number().int().positive(),
  treasuryChannel: ChannelId,
});
type Input = z.infer<typeof Input>;

interface Beneficiary {
  name: string;
  verified: boolean;
  ageDays: number;
}

export const cutoff = (input: Pick<Input, "type" | "valueDate">) => `${input.valueDate}T${POLICY.cutoffUtc[input.type]}:00.000Z`;

/** Reasons the payment can't be approved at all. Pure. */
export function blockers(b: Beneficiary | undefined, hits: string[] | undefined, sentToday: number | undefined, input: Pick<Input, "amount" | "dailyLimit">): string[] {
  const out: string[] = [];
  if (!b) out.push("the beneficiary account could not be read");
  else if (!b.verified) out.push(`beneficiary account is not verified${b.ageDays < POLICY.newBeneficiaryDays ? ` and was added ${b.ageDays} day(s) ago` : ""}`);
  if (hits === undefined) out.push("sanctions screening could not run");
  else if (hits.length) out.push(`sanctions match: ${hits.join("; ")}`);
  if (sentToday === undefined) out.push("today's outflow could not be read");
  else if (sentToday + input.amount > input.dailyLimit) out.push(`daily limit: ${sentToday + input.amount} would exceed ${input.dailyLimit}`);
  return out;
}

export const treasuryPaymentApproval: WorkflowDef<Input> = {
  id: "treasury-payment-approval",
  title: "Treasury payment approval (dual control)",
  org: "Finance",
  team: "treasury",
  description:
    "Check an outbound wire or ACH for beneficiary verification, sanctions, duplicates and the daily outflow limit; require a checker who isn't the maker and, over 100,000, the CFO; lapse at the rail's cut-off; release the Modern Treasury payment order exactly once and escalate it if it's returned or failed.",
  input: Input,
  audit: true,
  tickEvery: "rate(15 minutes)",
  agents: [
    {
      name: "beneficiary",
      needs: ["moderntreasury"],
      async run({ input, providers, startedAt }) {
        const mt = providers.moderntreasury!;
        const acct = await mt.getExternalAccount(input.receivingAccountId);
        const cp = await mt.getCounterparty(acct.counterparty_id);
        const ageDays = Math.floor((startedAt.getTime() - Date.parse(acct.created_at)) / DAY);
        const data: Beneficiary = { name: acct.party_name || cp.name, verified: acct.verification_status === "verified", ageDays };
        return { summary: `${data.name}: ${acct.verification_status}, added ${ageDays} day(s) ago`, data };
      },
    },
    {
      name: "screening",
      needs: ["moderntreasury", "screening"],
      async run({ input, providers }) {
        const acct = await providers.moderntreasury!.getExternalAccount(input.receivingAccountId);
        const cp = await providers.moderntreasury!.getCounterparty(acct.counterparty_id);
        const hits = (await providers.screening!.search(cp.name)).filter((h) => (h.score ?? 100) >= 90).map((h) => `${h.name} (${h.source})`);
        return { summary: hits.length ? `${hits.length} sanctions match(es)` : "no sanctions match", data: hits };
      },
    },
    {
      name: "history",
      needs: ["moderntreasury"],
      async run({ input, providers, startedAt }) {
        const mt = providers.moderntreasury!;
        const live = (p: { status: string }) => !["cancelled", "failed", "returned", "denied"].includes(p.status);
        const sameAccount = await mt.listPaymentOrders({ receiving_account_id: input.receivingAccountId });
        const since = startedAt.getTime() - POLICY.duplicateWindowDays * DAY;
        const duplicates = sameAccount.filter((p) => live(p) && p.amount === input.amount && p.metadata?.acme_payment_id !== input.paymentId && Date.parse(p.created_at ?? "1970-01-01") >= since).map((p) => p.metadata?.acme_payment_id ?? p.id);
        const today = await mt.listPaymentOrders({ originating_account_id: input.originatingAccountId, effective_date_start: input.valueDate, effective_date_end: input.valueDate });
        const sentToday = today.filter((p) => live(p) && p.direction === "credit" && p.effective_date === input.valueDate && p.metadata?.acme_payment_id !== input.paymentId).reduce((t, p) => t + p.amount, 0);
        return { summary: `${duplicates.length} possible duplicate(s); ${money(sentToday, input.currency)} already out on ${input.valueDate}`, data: { duplicates, sentToday } };
      },
    },
  ],

  plan({ input }, results) {
    const b = out<Beneficiary>(results, "beneficiary");
    const hits = out<string[]>(results, "screening");
    const hist = out<{ duplicates: string[]; sentToday: number }>(results, "history");
    const amount = money(input.amount, input.currency);
    const stop = blockers(b, hits, hist?.sentToday, input);
    const post = (id: string, text: string): PlannedAction<Input> => ({
      id,
      kind: id,
      provider: "slack",
      agent: "beneficiary",
      gate: "auto",
      summary: { paymentId: input.paymentId },
      async execute({ providers }) {
        return { ref: (await providers.slack!.postMessage(input.treasuryChannel, text)).ts };
      },
    });
    if (stop.length) return [post("slack.post_blocked", `:no_entry: ${input.paymentId} ${input.type} ${amount} blocked: ${stop.join("; ")}. Nothing will be sent.`)];

    const deadline = cutoff(input);
    const checker = `treasury.approve:${input.paymentId}`;
    const cfo = `cfo.approve:${input.paymentId}`;
    const needsCfo = input.amount > POLICY.cfoOver;
    const release = `moderntreasury.release:${input.paymentId}`;
    const actions: PlannedAction<Input>[] = [
      post("slack.post_payment", `:bank: ${input.paymentId}: ${input.type} ${amount} to ${b!.name} for "${input.purpose}", value ${input.valueDate}, entered by <@${input.maker}>. Needs ${needsCfo ? "treasury and CFO" : "treasury"} approval before ${deadline.slice(11, 16)} UTC.${hist!.duplicates.length ? ` :warning: Same amount to the same account recently: ${hist!.duplicates.join(", ")}.` : ""}`),
      {
        id: checker,
        kind: "treasury.approve",
        provider: "slack",
        agent: "beneficiary",
        gate: "auto",
        summary: { paymentId: input.paymentId, amount, beneficiary: b!.name, ...(hist!.duplicates.length ? { possibleDuplicates: hist!.duplicates } : {}) },
        awaitSignal: { from: input.approvers.treasury, notFrom: [input.maker], deadline, onDeadline: "reject" },
        async execute({ signal }) {
          return { ref: signal!.by };
        },
      },
    ];
    if (needsCfo) {
      actions.push({
        id: cfo,
        kind: "cfo.approve",
        provider: "slack",
        agent: "beneficiary",
        gate: "auto",
        summary: { paymentId: input.paymentId, amount },
        awaitSignal: { from: input.approvers.cfo, notFrom: [input.maker], distinctFrom: [checker], deadline, onDeadline: "reject" },
        requires: [checker],
        async execute({ signal }) {
          return { ref: signal!.by };
        },
      });
    }
    actions.push({
      id: release,
      kind: "moderntreasury.release",
      provider: "moderntreasury",
      agent: "beneficiary",
      gate: "auto",
      summary: { paymentId: input.paymentId, type: input.type, amount, valueDate: input.valueDate },
      requires: [needsCfo ? cfo : checker],
      async execute({ providers }) {
        const mt = providers.moderntreasury!;
        const existing = (await mt.listPaymentOrders({ "metadata[acme_payment_id]": input.paymentId })).find((p) => p.metadata?.acme_payment_id === input.paymentId);
        if (existing) return { ref: existing.id, detail: { reused: true, status: existing.status } };
        // Re-check the beneficiary at release: a change since approval stops the payment.
        const acct = await mt.getExternalAccount(input.receivingAccountId);
        if (acct.verification_status !== "verified") throw new FatalError(`beneficiary account is now ${acct.verification_status}`);
        const po = await mt.createPaymentOrder({ type: input.type, amount: input.amount, currency: input.currency, originatingAccountId: input.originatingAccountId, receivingAccountId: input.receivingAccountId, description: input.purpose, effectiveDate: input.valueDate, metadata: { acme_payment_id: input.paymentId } }, input.paymentId);
        return { ref: po.id, detail: { status: po.status } };
      },
      async reconcile({ providers }, receipt) {
        const po = await providers.moderntreasury!.getPaymentOrder(receipt.ref);
        return po.amount === input.amount && po.receiving_account_id === input.receivingAccountId ? { status: "match", detail: po.status } : { status: "drift", detail: `order now ${po.amount} to ${po.receiving_account_id}` };
      },
    });
    actions.push({
      id: `moderntreasury.settlement_check:${input.paymentId}`,
      kind: "moderntreasury.settlement_check",
      provider: "moderntreasury",
      agent: "beneficiary",
      gate: "auto",
      summary: { paymentId: input.paymentId, afterHours: 24 },
      requires: [release],
      delayAfter: { action: release, ms: DAY },
      async execute({ providers, applied }) {
        const po = await providers.moderntreasury!.getPaymentOrder(applied[release]!.ref);
        if (po.status === "completed") throw new SkipAction("completed");
        const bad = ["returned", "failed", "cancelled"].includes(po.status);
        await providers.slack!.postMessage(input.treasuryChannel, `${bad ? ":rotating_light:" : ":hourglass:"} ${input.paymentId} (${amount} to ${b!.name}) is ${po.status} a day after release.${bad ? " Treasury must contact the beneficiary and re-issue if needed." : ""}`);
        return { ref: po.id, detail: { status: po.status } };
      },
    });
    actions.push({
      id: `slack.dm_maker:${input.paymentId}`,
      kind: "slack.dm_maker",
      provider: "slack",
      agent: "beneficiary",
      gate: "auto",
      summary: { paymentId: input.paymentId },
      after: [release, checker, ...(needsCfo ? [cfo] : [])],
      async execute({ providers, applied }) {
        const r = applied[release];
        return { ref: (await providers.slack!.postMessage(input.maker, r ? `${input.paymentId} was released: payment order ${r.ref} for ${amount}, value ${input.valueDate}.` : `${input.paymentId} (${amount}) was not released; nothing was sent.`)).ts };
      },
    });
    return actions;
  },

  output({ input }, results) {
    const b = out<Beneficiary>(results, "beneficiary");
    const hits = out<string[]>(results, "screening");
    const hist = out<{ duplicates: string[]; sentToday: number }>(results, "history");
    const stop = blockers(b, hits, hist?.sentToday, input);
    return stop.length ? { mode: "blocked", reasons: stop } : { mode: "approval", approvals: input.amount > POLICY.cfoOver ? ["treasury", "cfo"] : ["treasury"], cutoff: cutoff(input), possibleDuplicates: hist!.duplicates.length };
  },

  catalog: [
    { kind: "slack.post_blocked", provider: "slack", gate: "auto", description: "Unverified beneficiary, sanctions, unreadable data or daily limit: nothing is sent" },
    { kind: "slack.post_payment", provider: "slack", gate: "auto", description: "Payment, approvals needed and cut-off" },
    { kind: "treasury.approve", provider: "slack", gate: "auto", description: "Signal: checker who isn't the maker, before cut-off" },
    { kind: "cfo.approve", provider: "slack", gate: "auto", description: "Signal: CFO over 100,000, not the maker or checker" },
    { kind: "moderntreasury.release", provider: "moderntreasury", gate: "auto", description: "Payment order, once per payment id" },
    { kind: "moderntreasury.settlement_check", provider: "moderntreasury", gate: "auto", description: "Escalate if not completed a day after release" },
    { kind: "slack.dm_maker", provider: "slack", gate: "auto", description: "Outcome to the maker" },
  ],
};
