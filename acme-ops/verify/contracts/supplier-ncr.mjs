import { action, agent, all, blocked, check, command, eq, noAction, restart, runs, start, startAgain } from "./lib.mjs";

const CHANNEL = "C0GENERAL01";
const APPROVER = "U_QUALITY_MGR";
// minor/major with a low reject rate → no hold; critical or ≥10% rejected → hold proposed.
const ncr = (id, over = {}) => ({
  ncrId: `NCR-${id.replaceAll("_", "-").toUpperCase()}`.slice(0, 40),
  supplier: { name: "Precision Castings", email: `${id.replaceAll("_", "-")}@precision.test` },
  part: "GEMS-HSG-200",
  lot: "L2405",
  defect: "Porosity in the housing wall above spec",
  qtyInspected: 200,
  qtyRejected: 2,
  severity: "major",
  purchasingChannel: CHANNEL,
  approvers: [APPROVER],
  ...over,
});
const critical = (id) => ncr(id, { severity: "critical" });
const holds = ["gmail.draft_supplier_hold", "slack.announce_hold"];

function faulted(id, name, provider, scenario, assertions) {
  return check(id, name, [start(id, ncr(id))], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });
}

export const checks = [
  check("baseline", "A major defect at 1% rejected opens the CAPA, drafts the 8D request, holds the review and alerts Purchasing, with no hold", [start("baseline", ncr("baseline"))], all(runs([eq("phase", "DONE"), eq("outcome", "ok")]), runs([action("asana.open_capa", "applied")]), runs([action("gmail.draft_8d_request", "applied")]), runs([action("calendar.hold_8d_review", "applied")]), runs([action("slack.post_ncr", "applied")]), ...holds.map((h) => runs([noAction(h)])))),
  check("critical_hold_parked", "A critical defect proposes a supplier hold for approval", [start("critical_hold_parked", critical("critical"))], all(runs([eq("phase", "AWAITING_APPROVAL")]), ...holds.map((h) => runs([action(h, "pending_approval")])))),
  check("high_reject_rate_hold", "A major defect with 15% rejected also proposes a hold", [start("high_reject_rate_hold", ncr("highrate", { qtyRejected: 30 }))], all(runs([eq("phase", "AWAITING_APPROVAL")]), runs([action("gmail.draft_supplier_hold", "pending_approval")]))),
  check("approve_and_reconcile", "An approved hold is drafted and announced; the CAPA is read back with its due date", [start("approve_and_reconcile", critical("approved")), command("decide", 1, { decision: "approve", userId: APPROVER }), command("reconcile", 1)], all(runs([eq("phase", "DONE")]), ...holds.map((h) => runs([action(h, "applied")])), runs([action("asana.open_capa", "applied", 1, [eq("reconciled", "match")])]))),
  check("approve_by_stranger_refused", "A non-approver cannot put a supplier on hold", [start("approve_by_stranger_refused", critical("stranger")), command("decide", 1, { decision: "approve", userId: "U_BUYER" }, 403)], all(runs([eq("phase", "AWAITING_APPROVAL")]), runs([action("slack.announce_hold", "pending_approval")]))),
  check("reject", "Rejecting the hold keeps the supplier active", [start("reject", critical("rejected")), command("decide", 1, { decision: "reject", userId: APPROVER })], all(runs([eq("phase", "REJECTED")]), ...holds.map((h) => runs([action(h, "rejected")])))),
  check("duplicate_start", "A re-submitted NCR does not open a second CAPA", [start("duplicate_start", ncr("duplicate")), startAgain("duplicate_start", ncr("duplicate"))], runs([action("asana.open_capa", "applied", 1, [eq("attempts", 1)])])),
  check("concurrent_start", "Four more simultaneous submissions create one CAPA", [start("concurrent_start", ncr("concurrent")), startAgain("concurrent_start", ncr("concurrent"), 1, 4)], runs([action("asana.open_capa", "applied", 1, [eq("attempts", 1)])])),
  check("invalid_input_rejected", "More rejected than inspected is refused before anything runs", [start("invalid_input_rejected", ncr("invalid", { qtyRejected: 500 }), { expectStatus: 400 })], runs([], 0)),
  faulted("asana_auth_failure", "If Asana refuses, the CAPA fails visibly while the 8D request and alert still go out", "asana", "auth_failure", [action("asana.open_capa", "failed"), action("gmail.draft_8d_request", "applied"), action("slack.post_ncr", "applied"), eq("outcome", "partial")]),
  faulted("calendar_rate_limited", "Without the quality calendar no review is held; the CAPA still opens", "google-calendar", "rate_limited", [agent("review-slot", "failed"), noAction("calendar.hold_8d_review"), action("asana.open_capa", "applied")]),
  faulted("gmail_auth_failure", "A Gmail failure fails the 8D draft only", "gmail", "auth_failure", [action("gmail.draft_8d_request", "failed"), action("asana.open_capa", "applied")]),
  check("restart_while_parked", "A hold parked for approval survives a runtime restart and is applied when approved afterwards", [start("restart_while_parked", critical("restart")), restart, command("decide", 1, { decision: "approve", userId: APPROVER })], runs([eq("phase", "DONE"), action("slack.announce_hold", "applied")])),
  blocked("repeat_supplier_escalation", "Two or more open CAPAs for the same supplier escalate to a hold", "setup_missing", "The Asana twin's task listing returns generic sample tasks, so open CAPAs per supplier can't be counted; the rule is code (holdReasons) and is unit-level only.", ["acme-ops/src/workflows/supplier-ncr.ts capa-history, holdReasons", "Asana twin GET /tasks returns sample data"]),
];

export default {
  workflow: "supplier-ncr",
  providers: ["hubspot", "asana", "google-calendar", "slack", "gmail"],
  context: {
    goal: "Prove the supplier-ncr AgentCore runtime: rejected lot → CAPA in Asana, 8D request draft in Gmail, review hold on Calendar, Purchasing alert in Slack; supplier hold gated; reconcile reads the CAPA back.",
    workflow: "POST /invocations {action:start} runs supplier, history and calendar agents, applies the CAPA actions and parks a hold when policy requires; {action:decide} applies it; {action:reconcile} re-reads Asana. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["approve_by_stranger_refused"],
    schema_and_value_boundaries: ["invalid_input_rejected", "high_reject_rate_hold"],
    amount_currency_quantity: ["high_reject_rate_hold", "invalid_input_rejected"],
    duplicate_replay: ["duplicate_start"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: ["repeat_supplier_escalation"],
    delayed_or_missing_events: "No inbound provider events.",
    provider_auth_and_scopes: ["asana_auth_failure", "gmail_auth_failure"],
    rate_limit_server_error_timeout: ["calendar_rate_limited"],
    accepted_effect_response_loss: "Covered by side-effect claims.",
    partial_effects_and_recovery: ["asana_auth_failure"],
    restart_and_durability: ["restart_while_parked"],
    reconciliation: ["approve_and_reconcile"],
    cancellation_refund_entitlements: ["reject"],
    data_and_privacy_boundaries: "Supplier communications are drafts; holds go to the internal Purchasing channel.",
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: ["acme-ops/src/workflows/supplier-ncr.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/providers/work.ts AsanaClient", "acme-ops/src/providers/google.ts"],
};
