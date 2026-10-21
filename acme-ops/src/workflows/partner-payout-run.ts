import { z } from "zod";
import { FatalError, ProviderError } from "../kit/errors";
import type { AgentResults, PlannedAction, WorkflowDef } from "../kit/types";
import type { StripeTransfer } from "../providers/stripe";
import { Approvers, ChannelId, money, out } from "./shared";

// Finance · partner-ops.
// Trigger: the month-end commission statement for reseller and referral partners.
// Each partner is paid by a Stripe transfer to their connected account. Money out
// in bulk, so: one transfer per partner per run, ever; limits in code; a lost
// response is retried with the same idempotency key, never re-sent as a new payment.

export const POLICY = {
  /** A transfer above this waits for approval. */
  autoTransferMaxMinor: 250_000,
  /** Transfers go out automatically until their sum reaches this; the rest wait for approval. */
  autoRunMaxMinor: 2_500_000,
  /** Beyond either ceiling the run pays nothing and goes to people. */
  hardMaxPartners: 200,
  hardMaxTotalMinor: 25_000_000,
  currency: "usd",
} as const;

const Partner = z.object({
  partnerId: z.string().regex(/^P-[\w-]{2,40}$/, "partner id like P-1042"),
  /** The partner's Stripe connected account. */
  account: z.string().regex(/^[\w-]{3,64}$/, "Stripe connected account id like acct_1N..."),
  amountMinor: z.number().int().positive(),
});
const Input = z
  .object({
    payoutRunId: z.string().regex(/^PO-[\w-]{3,40}$/, "payout run id like PO-2026-10"),
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "statement month like 2026-10"),
    partners: z.array(Partner).min(1).max(1_000),
    financeChannel: ChannelId,
    financeWorkspace: z.string().min(1).default("acme-finance"),
    approvers: Approvers,
  })
  .refine((i) => new Set(i.partners.map((p) => p.partnerId)).size === i.partners.length, { message: "a partner appears twice in the statement", path: ["partners"] });
type Input = z.infer<typeof Input>;

interface AccountState {
  partnerId: string;
  account: string;
  ok: boolean;
  reason: string;
}
interface Accounts {
  accounts: AccountState[];
}
interface Ledger {
  /** Transfers already in this run's transfer group, by partner. */
  paid: Record<string, { transfer: string; amountMinor: number }>;
  duplicates: string[];
}
export interface Line {
  partnerId: string;
  account: string;
  amountMinor: number;
}
export interface Gated extends Line {
  gate: "auto" | "approval";
  why: string;
}
interface Plan {
  mode: "pay" | "halted" | "blocked" | "nothing";
  reason: string;
  transfers: Gated[];
  skipped: { partnerId: string; reason: string }[];
  totals: { count: number; amountMinor: number; autoMinor: number; approvalMinor: number };
}

/** Gates each transfer and enforces the run limits. Pure. */
export function gateTransfers(lines: Line[]): { mode: "pay" | "halted"; reason: string; transfers: Gated[] } {
  const total = lines.reduce((s, l) => s + l.amountMinor, 0);
  if (lines.length > POLICY.hardMaxPartners || total > POLICY.hardMaxTotalMinor) {
    return { mode: "halted", reason: `${lines.length} transfer(s) totalling ${money(total)} exceed the automation ceiling (${POLICY.hardMaxPartners} / ${money(POLICY.hardMaxTotalMinor)})`, transfers: [] };
  }
  let auto = 0;
  const transfers = [...lines]
    .sort((a, b) => a.partnerId.localeCompare(b.partnerId))
    .map((l): Gated => {
      if (l.amountMinor > POLICY.autoTransferMaxMinor) return { ...l, gate: "approval", why: "above the single-transfer limit" };
      if (auto + l.amountMinor > POLICY.autoRunMaxMinor) return { ...l, gate: "approval", why: "run auto-payout limit reached" };
      auto += l.amountMinor;
      return { ...l, gate: "auto", why: "within limits" };
    });
  return { mode: "pay", reason: `${transfers.length} transfer(s)`, transfers };
}

const idempotencyKey = (input: Input, partnerId: string) => `${input.payoutRunId}-${partnerId}`;

export const partnerPayoutRun: WorkflowDef<Input> = {
  id: "partner-payout-run",
  title: "Partner payout run",
  org: "Finance",
  team: "partner-ops",
  description:
    "Pay the month's partner commissions by Stripe transfer to each partner's connected account. Accounts are checked and earlier transfers in the run's transfer group are found in parallel; each partner is paid at most once per run, with the same idempotency key on every retry so a lost response never becomes a second payment. Small transfers go out automatically, large ones and anything past the run limit wait for approval, and a run beyond the ceiling pays nothing. The run is recorded in Asana and posted to Slack.",
  input: Input,
  agents: [
    {
      name: "account-check",
      needs: ["stripe"],
      async run({ input, providers }) {
        const stripe = providers.stripe!;
        const accounts: AccountState[] = [];
        for (const p of input.partners) {
          try {
            const a = await stripe.getAccount(p.account);
            const transfers = a.capabilities?.transfers;
            const disabled = a.requirements?.disabled_reason;
            // An account that reports the transfers capability must have it active; one that reports nothing is checked by Stripe at transfer time.
            const ok = !disabled && (transfers === undefined || transfers === null || transfers === "active");
            accounts.push({ partnerId: p.partnerId, account: p.account, ok, reason: ok ? "account active" : disabled ? `account disabled: ${disabled}` : `transfers capability ${transfers}` });
          } catch (err) {
            if (err instanceof ProviderError && err.status === 404) accounts.push({ partnerId: p.partnerId, account: p.account, ok: false, reason: "no such connected account" });
            else throw err;
          }
        }
        return { summary: `${accounts.filter((a) => a.ok).length}/${accounts.length} account(s) can receive transfers`, data: { accounts } satisfies Accounts };
      },
    },
    {
      name: "ledger-check",
      needs: ["stripe"],
      async run({ input, providers }) {
        const prior = (await providers.stripe!.listTransfers(input.payoutRunId)).filter((t) => t.transfer_group === input.payoutRunId);
        const paid: Ledger["paid"] = {};
        const duplicates: string[] = [];
        for (const t of prior) {
          const partner = t.metadata?.acme_partner;
          if (!partner) continue;
          if (paid[partner]) duplicates.push(partner);
          else paid[partner] = { transfer: t.id, amountMinor: t.amount };
        }
        return { summary: `${Object.keys(paid).length} partner(s) already paid in ${input.payoutRunId}${duplicates.length ? `; ${duplicates.length} DUPLICATE(S)` : ""}`, data: { paid, duplicates } satisfies Ledger };
      },
    },
  ],

  compose: {
    name: "payout-plan",
    async run({ input }, results) {
      const p = planFrom(input, results);
      return { summary: `${p.mode}: ${p.reason}`, data: p };
    },
  },

  plan({ input }, results) {
    const p = out<Plan>(results, "payout-plan");
    if (!p) return [];
    const actions: PlannedAction<Input>[] = [];
    for (const t of p.transfers) {
      actions.push({
        id: `stripe.transfer:${t.partnerId}`,
        kind: "stripe.transfer",
        provider: "stripe",
        agent: "payout-plan",
        gate: t.gate,
        summary: { partner: t.partnerId, account: t.account, amount: money(t.amountMinor), why: t.why },
        async execute({ providers }) {
          const stripe = providers.stripe!;
          // Another run (or an earlier attempt whose response was lost and not retried) may have paid already.
          const prior = (await stripe.listTransfers(input.payoutRunId)).find((x) => x.transfer_group === input.payoutRunId && x.metadata?.acme_partner === t.partnerId);
          if (prior) return { ref: prior.id, detail: { amountMinor: prior.amount, reused: true } };
          // A held or lost response is retried by the HTTP client with this same key: Stripe returns the same transfer.
          const tr: StripeTransfer = await stripe.createTransfer(
            { amount: t.amountMinor, currency: POLICY.currency, destination: t.account, transferGroup: input.payoutRunId, description: `${input.payoutRunId} ${input.period} commission ${t.partnerId}`, metadata: { acme_partner: t.partnerId, acme_period: input.period } },
            idempotencyKey(input, t.partnerId),
          );
          return { ref: tr.id, detail: { amountMinor: tr.amount, destination: tr.destination } };
        },
        async reconcile({ providers }, receipt) {
          const tr = await providers.stripe!.getTransfer(receipt.ref);
          if (tr.amount !== t.amountMinor || tr.destination !== t.account) return { status: "drift", detail: `transfer ${tr.amount} to ${tr.destination}` };
          if ((tr.amount_reversed ?? 0) > 0) return { status: "drift", detail: `reversed ${money(tr.amount_reversed ?? 0)}` };
          return { status: "match" };
        },
      });
    }

    const t = p.totals;
    const lines = [
      `${input.payoutRunId} (${input.period}): ${p.mode} - ${p.reason}.`,
      `Transfers: ${t.count} for ${money(t.amountMinor)} (${money(t.autoMinor)} automatic, ${money(t.approvalMinor)} awaiting approval).`,
      ...p.transfers.map((x) => `- ${x.partnerId} -> ${x.account}: ${money(x.amountMinor)} ${x.gate} (${x.why})`),
      ...p.skipped.map((x) => `- SKIPPED ${x.partnerId}: ${x.reason}`),
    ];
    actions.push({
      id: "asana.payout_record",
      kind: "asana.payout_record",
      provider: "asana",
      agent: "payout-plan",
      gate: "auto",
      summary: { payoutRunId: input.payoutRunId, mode: p.mode, transfers: t.count },
      async execute({ providers }) {
        const task = await providers.asana!.createTask({ name: `${input.payoutRunId}: partner payouts ${input.period} (${p.mode})`, notes: lines.join("\n"), workspace: input.financeWorkspace });
        return { ref: task.gid };
      },
    });
    const icon = p.mode === "pay" ? ":money_with_wings:" : p.mode === "nothing" ? ":white_check_mark:" : ":rotating_light:";
    const text = `${icon} ${input.payoutRunId} (${input.period}): ${p.mode === "pay" ? `${t.count} transfer(s), ${money(t.amountMinor)}; ${money(t.autoMinor)} paying now${t.approvalMinor ? `, ${money(t.approvalMinor)} needs approval` : ""}` : p.reason}.${p.skipped.length ? ` ${p.skipped.length} skipped.` : ""}`;
    actions.push({
      id: "slack.post_payout_run",
      kind: "slack.post_payout_run",
      provider: "slack",
      agent: "payout-plan",
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
    const p = out<Plan>(results, "payout-plan");
    if (!p) return { mode: "not decided" };
    return { mode: p.mode, reason: p.reason, transfers: p.totals.count, amountMinor: p.totals.amountMinor, autoMinor: p.totals.autoMinor, approvalMinor: p.totals.approvalMinor, skipped: p.skipped };
  },

  catalog: [
    { kind: "stripe.transfer", provider: "stripe", gate: "auto", description: "Transfer the partner's commission to their connected account; approval above $2,500 or past the $25,000 run limit; at most once per partner per run" },
    { kind: "asana.payout_record", provider: "asana", gate: "auto", description: "Payout run record for finance and audit" },
    { kind: "slack.post_payout_run", provider: "slack", gate: "auto", description: "Payout run summary in the finance channel" },
  ],
};

function planFrom(input: Input, results: AgentResults): Plan {
  const accounts = out<Accounts>(results, "account-check");
  const ledger = out<Ledger>(results, "ledger-check");
  const empty = { count: 0, amountMinor: 0, autoMinor: 0, approvalMinor: 0 };
  // Fail closed: without the ledger we can't know who was paid already.
  if (!ledger) return { mode: "blocked", reason: "earlier transfers could not be read; paying nothing", transfers: [], skipped: [], totals: empty };
  if (ledger.duplicates.length) return { mode: "blocked", reason: `partner(s) already paid twice in this run (${ledger.duplicates.join(", ")}); paying nothing until finance reviews`, transfers: [], skipped: [], totals: empty };
  if (!accounts) return { mode: "blocked", reason: "connected accounts could not be checked; paying nothing", transfers: [], skipped: [], totals: empty };
  const skipped: Plan["skipped"] = [];
  const due: Line[] = [];
  for (const p of input.partners) {
    const acct = accounts.accounts.find((a) => a.partnerId === p.partnerId);
    if (ledger.paid[p.partnerId]) skipped.push({ partnerId: p.partnerId, reason: `already paid (${ledger.paid[p.partnerId]!.transfer})` });
    else if (!acct?.ok) skipped.push({ partnerId: p.partnerId, reason: acct?.reason ?? "account not checked" });
    else due.push({ partnerId: p.partnerId, account: p.account, amountMinor: p.amountMinor });
  }
  if (!due.length) return { mode: "nothing", reason: "no partner left to pay", transfers: [], skipped, totals: empty };
  const g = gateTransfers(due);
  const sum = (xs: Gated[]) => xs.reduce((s, x) => s + x.amountMinor, 0);
  return {
    mode: g.mode,
    reason: g.reason,
    transfers: g.transfers,
    skipped,
    totals: { count: g.transfers.length, amountMinor: sum(g.transfers), autoMinor: sum(g.transfers.filter((x) => x.gate === "auto")), approvalMinor: sum(g.transfers.filter((x) => x.gate === "approval")) },
  };
}
