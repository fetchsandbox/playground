import { action, actionKind, agent, all, check, command, eq, runs, start } from "./lib.mjs";

// Executable expectations for an AP three-way match batch (Kit v2: per-bill
// checkpoints, signals with segregation of duties, audit). Everything the
// runtime decides is read from NetSuite (vendor bills, purchase orders,
// receipts, SuiteQL duplicate search). FetchSandbox has no NetSuite twin
// ("Unknown providers: netsuite"), so this receipt measures how much of an
// ERP-centred AP control can be proven without one.
const AP = "C0FINANCE01";
const batch = (c, over = {}) => start(c, { batchId: `AP-${c.replaceAll("_", "-")}`.slice(0, 43), billIds: ["11", "12", "13", "14"], apChannel: AP, approvers: ["U_AP_LEAD", "U_AP_CLERK"], buyers: ["U_BUYER"], ...over });

export const checks = [
  check("baseline", "An AP batch posts its outcome to the AP channel", [batch("baseline")], runs([actionKind("slack.post_batch", "applied")])),
  check("bills_read_from_erp", "Pending bills, their purchase orders and receipts are read from the ERP", [batch("bills_read_from_erp")], runs([agent("match-engine", "ok"), eq("output.mode", "matched")])),
  check("clean_match_auto_approved", "A bill that matches its PO and receipts within the limit is approved without a person", [batch("clean_match_auto_approved", { billIds: ["11"] })], runs([action("netsuite.approve_bill:11", "applied")])),
  check("variance_needs_ap_approval", "A price variance within tolerance waits for an AP approver", [batch("variance_needs_ap_approval", { billIds: ["12"] })], runs([action("netsuite.approve_bill:12", "awaiting_signal")])),
  check("entering_clerk_cannot_approve", "The clerk who entered a bill can't approve its variance", [batch("entering_clerk_cannot_approve", { billIds: ["12"] }), command("signal", 1, { actionId: "netsuite.approve_bill:12", value: "approve", userId: "U_AP_CLERK" }, 403)], runs([action("netsuite.approve_bill:12", "awaiting_signal")])),
  check("over_billed_held", "A bill for more than was received is put on payment hold and routed to a buyer", [batch("over_billed_held", { billIds: ["13"] })], runs([action("netsuite.hold_bill:13", "applied"), action("netsuite.buyer_release:13", "awaiting_signal")])),
  check("duplicate_never_approved", "Bills sharing a vendor invoice number are held, never approved", [batch("duplicate_never_approved", { billIds: ["11", "14"] })], runs([actionKind("netsuite.approve_bill", null, 0), actionKind("netsuite.hold_bill", "applied", 2)])),
  check("erp_unreadable_approves_nothing", "When bills can't be read, nothing is approved and AP is told", [batch("erp_unreadable_approves_nothing")], runs([eq("output.mode", "blocked"), actionKind("netsuite.approve_bill", null, 0), actionKind("slack.post_batch", "applied")])),
  check("slack_rate_limited", "Slack rate limiting loses the summary only", [batch("slack_rate_limited")], all(runs([actionKind("slack.post_batch", "failed")])), { fault: { provider: "slack", scenario: "rate_limited", evidence: "refusal" } }),
  check("invalid_input_rejected", "A malformed batch id is rejected before any agent runs", [start("invalid_input_rejected", { batchId: "today", apChannel: AP, buyers: ["U_BUYER"] }, { expectStatus: 400 })], runs([], 0)),
];

export default {
  workflow: "invoice-three-way-match",
  providers: ["asana", "slack"],
  context: {
    goal: "Prove the invoice-three-way-match AgentCore runtime: AP batch → NetSuite vendor bills matched line by line to purchase orders and receipts (checkpointed per bill), duplicate search by invoice number and amount → clean matches approved automatically, tolerance variances by an AP approver who didn't enter the bill, over-billing and missing POs held for a buyer, duplicates held and never approved; summary to Slack, exceptions to Asana; hash-chained audit.",
    workflow: "POST /invocations {action:start}; {action:signal} for variance approvals and buyer releases; {action:evidence}. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["entering_clerk_cannot_approve"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: ["variance_needs_ap_approval", "over_billed_held"],
    duplicate_replay: ["duplicate_never_approved"],
    concurrency: "Bills are re-read before approval; a bill changed since the match is skipped (local tests).",
    ordering_and_stale_events: "A bill edited after the match is not approved on stale data (local tests).",
    delayed_or_missing_events: "Variance approvals default to 'stays pending' at the deadline (Kit v2).",
    provider_auth_and_scopes: ["erp_unreadable_approves_nothing"],
    rate_limit_server_error_timeout: ["slack_rate_limited"],
    accepted_effect_response_loss: "Approval is an idempotent status PATCH.",
    partial_effects_and_recovery: "The match is checkpointed per bill; a restart continues (Kit v2 tests).",
    restart_and_durability: "Waiting approvals survive restarts (Kit v2 tests).",
    reconciliation: "Automatic approvals reconcile against the bill's status (local tests).",
    cancellation_refund_entitlements: ["clean_match_auto_approved", "over_billed_held"],
    data_and_privacy_boundaries: "Only bill numbers, vendor ids and amounts leave the ERP.",
    cleanup_and_isolation: ["baseline"],
  },
  evidence: ["acme-ops/src/workflows/invoice-three-way-match.ts", "acme-ops/test/invoice-three-way-match.test.ts"],
};
