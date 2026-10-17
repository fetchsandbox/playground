import { action, agent, all, blocked, check, command, eq, noAction, restart, runs, start, startAgain } from "./lib.mjs";

// Twin seed: alice@acmecorp.com owns invoice in_3QaT2bVwXy5zA6Bc7D; dev@startupxyz.io
// owns in_7EfG8hIjKl9mN0Op1Q. Neither has a fulfillment task until a run schedules one,
// and that link persists, so checks are ordered: the late-order checks on dev's
// invoice run before the approval that moves its promise date.
const CHANNEL = "C0BILLING01";
const APPROVER = "U_CX_LEAD";
const ALICE = { customer: { email: "alice@acmecorp.com", name: "Alice Johnson" }, invoiceId: "in_3QaT2bVwXy5zA6Bc7D", ownerChannel: CHANNEL, approvers: [APPROVER] };
const DEV = { customer: { email: "dev@startupxyz.io", name: "Dev Patel" }, invoiceId: "in_7EfG8hIjKl9mN0Op1Q", ownerChannel: CHANNEL, approvers: [APPROVER], question: "Where is my order?", revisedPromiseOn: "2026-12-01" };
const lateOn = { ...DEV, promisedOn: "2025-02-01" };
const late = [eq("phase", "AWAITING_APPROVAL"), action("slack.alert_late_order", "applied"), action("asana.revise_promise_date", "pending_approval")];

function faulted(id, name, provider, scenario, assertions, input = ALICE) {
  return check(id, name, [start(id, input)], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });
}

export const checks = [
  check("baseline", "An unscheduled order gets a warehouse fulfillment task, linked on the invoice, and a drafted status reply", [start("baseline", { ...ALICE, promisedOn: "2026-12-15" })], all(runs([eq("phase", "DONE"), eq("outcome", "ok")]), runs([action("asana.schedule_fulfillment", "applied")]), runs([action("stripe.link_fulfillment", "applied")]), runs([action("gmail.draft_status_reply", "applied")]))),
  check("on_time_order_reply_only", "An order on track gets a reply draft and no alert", [start("on_time_order_reply_only", ALICE)], all(runs([eq("phase", "DONE")]), runs([action("gmail.draft_status_reply", "applied")]), runs([noAction("asana.schedule_fulfillment")]), runs([noAction("slack.alert_late_order")]))),
  check("late_order_detected", "An order past its promise date alerts the owner and parks a new promise date for approval", [start("late_order_detected", lateOn, { runId: "late-a-{{run_id}}" }), start("late_order_detected", DEV, { runId: "late-b-{{run_id}}" })], all(runs([], 2), runs([action("asana.schedule_fulfillment", "applied")]), runs(late))),
  check("approve_by_stranger_refused", "A non-approver cannot move a promise date", [start("approve_by_stranger_refused", DEV), command("decide", 1, { decision: "approve", userId: "U_AGENT" }, 403)], all(runs(late))),
  check("reject", "Rejecting keeps the original promise date", [start("reject", DEV), command("decide", 1, { decision: "reject", userId: APPROVER })], all(runs([eq("phase", "REJECTED")]), runs([action("asana.revise_promise_date", "rejected")]))),
  check("restart_approve_and_reconcile", "A late order parked for approval survives a runtime restart; approval moves the promise date, and Asana reads back the new date", [start("restart_approve_and_reconcile", DEV), restart, command("decide", 1, { decision: "approve", userId: APPROVER }), command("reconcile", 1)], all(runs([eq("phase", "DONE")]), runs([action("asana.revise_promise_date", "applied", 1, [eq("reconciled", "match")])]), runs([action("gmail.draft_revised_date", "applied")]))),
  check("after_new_date_on_time", "After the date moved, the same order reads as on time with no alert", [start("after_new_date_on_time", DEV)], all(runs([eq("phase", "DONE")]), runs([noAction("slack.alert_late_order")]))),
  check("someone_elses_order_refused", "Asking about another customer's invoice reveals nothing and drafts nothing", [start("someone_elses_order_refused", { ...ALICE, invoiceId: "in_7EfG8hIjKl9mN0Op1Q" })], all(runs([agent("order-lookup", "failed")]), runs([{ select: "actions[*]", count: 0, required: true }]))),
  check("duplicate_start", "A re-delivered question drafts one reply", [start("duplicate_start", ALICE), startAgain("duplicate_start", ALICE)], all(runs([action("gmail.draft_status_reply", "applied", 1, [eq("attempts", 1)])]))),
  check("concurrent_start", "Four more simultaneous deliveries draft one reply", [start("concurrent_start", ALICE), startAgain("concurrent_start", ALICE, 1, 4)], all(runs([action("gmail.draft_status_reply", "applied", 1, [eq("attempts", 1)])]))),
  check("invalid_input_rejected", "A malformed promise date is rejected before any agent runs", [start("invalid_input_rejected", { ...ALICE, promisedOn: "next week" }, { expectStatus: 400 })], runs([], 0)),
  faulted("asana_rate_limited", "Without the warehouse task the reply still goes out as 'checking'; nothing is rescheduled", "asana", "rate_limited", [agent("fulfillment", "failed"), action("gmail.draft_status_reply", "applied"), noAction("asana.schedule_fulfillment")]),
  faulted("stripe_auth_failure", "Without Stripe the order can't be verified: nothing is drafted or changed", "stripe", "auth_failure", [agent("order-lookup", "failed"), { select: "actions[*]", count: 0, required: true }]),
  faulted("gmail_rate_limited", "Gmail rate limiting fails the reply draft only", "gmail", "rate_limited", [action("gmail.draft_status_reply", "failed"), eq("outcome", "partial")]),
  blocked("carrier_tracking", "Shipped orders include the carrier's live tracking status", "setup_missing", "No carrier twin (UPS/FedEx/EasyPost/Shippo) in FetchSandbox; 'shipped' comes from the completed warehouse task only.", ["acme-ops/src/workflows/order-status.ts orderState()", "validate_integration providers:[easypost|shippo] → 'Unknown providers'"]),
  blocked("erp_order_lines", "Order lines, backorders and lead times come from the ERP", "setup_missing", "No ERP twin (SAP/Oracle/NetSuite); ACME's order is its Stripe invoice and the promise date its Asana task.", ["acme-ops/src/workflows/order-status.ts order-lookup", "validate_integration providers:[netsuite|sap] → 'Unknown providers'"]),
];

export default {
  workflow: "order-status",
  providers: ["stripe", "hubspot", "gmail", "slack", "asana"],
  context: {
    goal: "Prove the order-status AgentCore runtime: 'where is my order' → Stripe invoice ‖ Asana fulfillment task ‖ HubSpot owner → scheduling, reply draft, late alert; promise-date change gated.",
    workflow: "POST /invocations {action:start} computes the order state, schedules unscheduled orders and drafts the reply; late orders park a new promise date for {action:decide}; {action:reconcile} re-reads the Asana task.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["approve_by_stranger_refused", "someone_elses_order_refused"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: "No amounts are written.",
    duplicate_replay: ["duplicate_start"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: ["late_order_detected", "after_new_date_on_time"],
    delayed_or_missing_events: ["carrier_tracking"],
    provider_auth_and_scopes: ["stripe_auth_failure"],
    rate_limit_server_error_timeout: ["asana_rate_limited", "gmail_rate_limited"],
    accepted_effect_response_loss: "Covered by side-effect claims in local tests.",
    partial_effects_and_recovery: ["gmail_rate_limited"],
    restart_and_durability: ["restart_approve_and_reconcile"],
    reconciliation: ["restart_approve_and_reconcile", "erp_order_lines"],
    cancellation_refund_entitlements: ["reject"],
    data_and_privacy_boundaries: ["someone_elses_order_refused"],
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: ["acme-ops/src/workflows/order-status.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/providers/{stripe,hubspot,google,slack,work}.ts"],
};
