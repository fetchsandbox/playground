import { action, agent, all, check, command, eq, runs, start } from "./lib.mjs";

// Executable expectations for purchase request → PO (delegation-of-authority
// chain as Kit v2 signals with segregation of duties, reminder and lapse
// timers, idempotent PO creation). Vendor status, committed spend, duplicate
// search and the PO itself live in NetSuite, and the vendor is screened against
// the Consolidated Screening List; FetchSandbox has neither twin, so this
// receipt measures how much of a procurement control can be proven without them.
const PROCUREMENT = "C0PROCURE01";
const APPROVERS = { manager: ["U_MGR", "U_REQ"], finance: ["U_FIN", "U_MGR"], vp: ["U_VP"], cfo: ["U_CFO"] };
const input = (c, over = {}) => ({ requestId: `PR-${c.replaceAll("_", "-")}`.slice(0, 43), requester: "U_REQ", vendorId: "301", description: "Load-testing service, 12 months", amount: 12_000_00, currency: "usd", department: { id: "7", name: "Engineering", annualBudget: 100_000_00 }, expenseAccount: "6100", approvers: APPROVERS, procurementChannel: PROCUREMENT, ...over });
const request = (c, over) => start(c, input(c, over));
const id = (c, k) => `${k}:${input(c).requestId}`;
const approve = (c, role, userId, step, status = 200) => command("signal", step, { actionId: id(c, `approve.${role}`), value: "approve", userId }, status);

export const checks = [
  check("baseline", "A purchase request is announced to procurement with its approval chain", [request("baseline")], runs([action("slack.post_request", "applied")])),
  check("vendor_and_budget_read", "Vendor status, committed spend, duplicates and sanctions are read before any approval", [request("vendor_and_budget_read")], runs([agent("vendor", "ok"), agent("budget", "ok"), agent("duplicates", "ok"), agent("screening", "ok"), eq("output.mode", "approval")])),
  check("chain_by_amount", "A 12,000 request needs the manager, then finance", [request("chain_by_amount")], runs([eq("output.chain", ["manager", "finance"]), action(id("chain_by_amount", "approve.manager"), "awaiting_signal")])),
  check("requester_cannot_approve", "The requester can't approve their own request", [request("requester_cannot_approve"), approve("requester_cannot_approve", "manager", "U_REQ", 1, 403)], runs([action(id("requester_cannot_approve", "approve.manager"), "awaiting_signal")])),
  check("no_repeat_approver", "Someone who approved as manager can't also approve as finance", [request("no_repeat_approver"), approve("no_repeat_approver", "manager", "U_MGR", 1), approve("no_repeat_approver", "finance", "U_MGR", 1, 403)], runs([action(id("no_repeat_approver", "approve.finance"), "awaiting_signal")])),
  check("approved_po_raised_once", "After the full chain approves, one purchase order is raised in the ERP", [request("approved_po_raised_once"), approve("approved_po_raised_once", "manager", "U_MGR", 1), approve("approved_po_raised_once", "finance", "U_FIN", 1)], runs([action(id("approved_po_raised_once", "netsuite.create_po"), "applied"), action(id("approved_po_raised_once", "slack.dm_requester"), "applied")])),
  check("slow_approval_lapses", "An approval unanswered for 7 days lapses and no PO is raised (needs clock control)", [request("slow_approval_lapses"), { method: "POST", path: "/invocations", body: { action: "tick" }, expect_status: 200 }], runs([action(id("slow_approval_lapses", "approve.manager"), "rejected"), action(id("slow_approval_lapses", "netsuite.create_po"), "skipped")])),
  check("erp_unavailable_stops", "When the ERP can't be read nothing is approved and procurement is told", [request("erp_unavailable_stops")], all(runs([agent("vendor", "failed"), eq("output.mode", "stopped"), action("slack.post_stopped", "applied")]))),
  check("invalid_input_rejected", "A negative amount is rejected before any agent runs", [start("invalid_input_rejected", { ...input("baseline"), amount: -5 }, { expectStatus: 400 })], runs([], 0)),
];

export default {
  workflow: "purchase-request-to-po",
  providers: ["slack"],
  context: {
    goal: "Prove the purchase-request-to-po AgentCore runtime: a purchase request → vendor status, committed department spend, duplicate POs (SuiteQL) and sanctions screening in parallel → delegation-of-authority chain (manager; finance over 5,000 or over budget; VP over 50,000; CFO over 250,000) as signals with no self- or repeat approval, reminder at 3 days, lapse at 7 → NetSuite purchase order raised once by request id, requester told the PO number.",
    workflow: "POST /invocations {action:start}; {action:signal} for each approval; {action:tick} fires the reminder and lapse. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["requester_cannot_approve", "no_repeat_approver"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: ["chain_by_amount"],
    duplicate_replay: "Duplicate POs are flagged by vendor and amount; the PO is looked up by request id before creation (local tests).",
    concurrency: "Signals are compare-and-swap on the run.",
    ordering_and_stale_events: ["no_repeat_approver"],
    delayed_or_missing_events: ["slow_approval_lapses"],
    provider_auth_and_scopes: ["erp_unavailable_stops"],
    rate_limit_server_error_timeout: ["erp_unavailable_stops"],
    accepted_effect_response_loss: "PO creation is looked up by external id first.",
    partial_effects_and_recovery: ["approved_po_raised_once"],
    restart_and_durability: "Approval signals and timers survive restarts (Kit v2 tests).",
    reconciliation: "The PO reconciles against its vendor in the ERP.",
    cancellation_refund_entitlements: "A vendor put on hold during approval gets no PO (local tests).",
    data_and_privacy_boundaries: "Only request metadata is posted to Slack.",
    cleanup_and_isolation: ["baseline"],
  },
  evidence: ["acme-ops/src/workflows/purchase-request-to-po.ts", "acme-ops/test/purchase-request-to-po.test.ts"],
};
