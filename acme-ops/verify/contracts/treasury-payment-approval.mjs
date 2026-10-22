import { action, agent, all, check, command, eq, runs, start } from "./lib.mjs";

// Executable expectations for treasury payment approval (dual control as Kit v2
// signals with segregation of duties, cut-off deadline, idempotent payment
// order, next-day settlement check). Beneficiary accounts, payment history and
// payment orders live in Modern Treasury and the counterparty is screened
// against the Consolidated Screening List; FetchSandbox has neither twin, so
// this receipt measures how much of a payment control can be proven without a
// payment-operations twin.
const TREASURY = "C0TREASURY1";
const VALUE_DATE = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const input = (c, over = {}) => ({ paymentId: `PAY-${c.replaceAll("_", "-")}`.slice(0, 44), type: "wire", amount: 40_000_00, currency: "usd", originatingAccountId: "ia_ops", receivingAccountId: "ea_northwind", purpose: "Invoice NW-1182", valueDate: VALUE_DATE, maker: "U_MAKER", approvers: { treasury: ["U_TREAS", "U_MAKER", "U_TREAS_2"], cfo: ["U_CFO", "U_TREAS"] }, dailyLimit: 1_000_000_00, treasuryChannel: TREASURY, ...over });
const pay = (c, over) => start(c, input(c, over));
const id = (c, k) => `${k}:${input(c).paymentId}`;
const approve = (c, kind, userId, status = 200) => command("signal", 1, { actionId: id(c, kind), value: "approve", userId }, status);

export const checks = [
  check("baseline", "A payment is announced to treasury with its approvals and cut-off", [pay("baseline")], runs([action("slack.post_payment", "applied")])),
  check("beneficiary_and_history_read", "Beneficiary verification, sanctions, duplicates and daily outflow are read before any approval", [pay("beneficiary_and_history_read")], runs([agent("beneficiary", "ok"), agent("screening", "ok"), agent("history", "ok"), eq("output.mode", "approval")])),
  check("maker_cannot_approve", "The maker can't approve their own payment", [pay("maker_cannot_approve"), approve("maker_cannot_approve", "treasury.approve", "U_MAKER", 403)], runs([action(id("maker_cannot_approve", "treasury.approve"), "awaiting_signal")])),
  check("checker_releases_once", "A checker's approval releases exactly one payment order", [pay("checker_releases_once"), approve("checker_releases_once", "treasury.approve", "U_TREAS")], runs([action(id("checker_releases_once", "moderntreasury.release"), "applied"), action(id("checker_releases_once", "slack.dm_maker"), "applied")])),
  check("cfo_distinct_from_checker", "Over 100,000 the CFO must approve too, and can't be the checker", [pay("cfo_distinct_from_checker", { amount: 250_000_00 }), approve("cfo_distinct_from_checker", "treasury.approve", "U_TREAS"), approve("cfo_distinct_from_checker", "cfo.approve", "U_TREAS", 403)], runs([action(id("cfo_distinct_from_checker", "cfo.approve"), "awaiting_signal")])),
  check("cutoff_lapses", "Unapproved at the rail's cut-off, the payment lapses and nothing is sent (needs clock control)", [pay("cutoff_lapses"), { method: "POST", path: "/invocations", body: { action: "tick" }, expect_status: 200 }], runs([action(id("cutoff_lapses", "treasury.approve"), "rejected"), action(id("cutoff_lapses", "moderntreasury.release"), "skipped")])),
  check("returned_payment_escalated", "A payment returned the day after release is escalated (needs clock control and a returned order)", [pay("returned_payment_escalated"), approve("returned_payment_escalated", "treasury.approve", "U_TREAS"), { method: "POST", path: "/invocations", body: { action: "tick" }, expect_status: 200 }], runs([action(id("returned_payment_escalated", "moderntreasury.settlement_check"), "applied")])),
  check("bank_unavailable_blocks", "When payment data can't be read nothing is approved or sent", [pay("bank_unavailable_blocks")], all(runs([agent("beneficiary", "failed"), eq("output.mode", "blocked"), action("slack.post_blocked", "applied")]))),
  check("invalid_input_rejected", "A non-USD currency is rejected before any agent runs", [start("invalid_input_rejected", { ...input("baseline"), currency: "btc" }, { expectStatus: 400 })], runs([], 0)),
];

export default {
  workflow: "treasury-payment-approval",
  providers: ["slack"],
  context: {
    goal: "Prove the treasury-payment-approval AgentCore runtime: an outbound wire/ACH → beneficiary verification and age, sanctions screening, possible duplicates and the daily outflow limit in parallel → checker (not the maker) and, over 100,000, CFO (not the maker or checker) as signals with the rail's cut-off as deadline → Modern Treasury payment order created once (idempotency key and metadata lookup), beneficiary re-checked at release → settlement re-read a day later, returned or failed payments escalated.",
    workflow: "POST /invocations {action:start}; {action:signal} for each approval; {action:tick} fires the cut-off and the settlement check. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["maker_cannot_approve", "cfo_distinct_from_checker"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: ["cfo_distinct_from_checker"],
    duplicate_replay: "The order is looked up by payment id and created with it as idempotency key (local tests).",
    concurrency: "Signals are compare-and-swap on the run.",
    ordering_and_stale_events: "A beneficiary changed after approval is not paid (local tests).",
    delayed_or_missing_events: ["cutoff_lapses", "returned_payment_escalated"],
    provider_auth_and_scopes: ["bank_unavailable_blocks"],
    rate_limit_server_error_timeout: ["bank_unavailable_blocks"],
    accepted_effect_response_loss: "Idempotency key returns the first order on a retried create.",
    partial_effects_and_recovery: ["checker_releases_once"],
    restart_and_durability: "Approval signals and timers survive restarts (Kit v2 tests).",
    reconciliation: "The order reconciles against amount and beneficiary.",
    cancellation_refund_entitlements: ["returned_payment_escalated"],
    data_and_privacy_boundaries: "Account numbers are never read or posted; ids only.",
    cleanup_and_isolation: ["baseline"],
  },
  evidence: ["acme-ops/src/workflows/treasury-payment-approval.ts", "acme-ops/test/treasury-payment-approval.test.ts"],
};
