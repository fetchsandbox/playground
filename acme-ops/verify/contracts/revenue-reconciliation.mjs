import { action, actionKind, agent, all, blocked, check, command, eq, runs, start, startAgain } from "./lib.mjs";

// Twin seed: Stripe has two paying customers (alice@acmecorp.com active,
// dev@startupxyz.io past_due) and one succeeded refund; HubSpot has no
// customers. So every fresh run finds 2 "paying but not in CRM" variances,
// each proposed as a gated HubSpot fix. The approving check runs LAST because
// it changes HubSpot for every later run in the session.
const CHANNEL = "G0PRIVATE01"; // seeded #finance-private on the Slack twin
const APPROVER = "U_CONTROLLER";
const input = { financeChannel: CHANNEL, approvers: [APPROVER] };
const parked = [eq("phase", "AWAITING_APPROVAL")];

function faulted(id, name, provider, scenario, assertions) {
  return check(id, name, [start(id, input)], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });
}

export const checks = [
  check("baseline", "Month-end run posts the variance report and proposes one gated CRM fix per paying customer missing from HubSpot", [start("baseline", input)], all(runs([...parked, eq("outcome", "ok")]), runs([action("slack.post_report", "applied")]), runs([actionKind("hubspot.mark_customer", "pending_approval", 2)]))),
  check("approve_by_stranger_refused", "A non-approver cannot apply CRM fixes", [start("approve_by_stranger_refused", input), command("decide", 1, { decision: "approve", userId: "U_INTERN" }, 403)], all(runs(parked), runs([actionKind("hubspot.mark_customer", "pending_approval", 2)]))),
  check("reject", "Rejecting leaves HubSpot untouched", [start("reject", input), command("decide", 1, { decision: "reject", userId: APPROVER })], all(runs([eq("phase", "REJECTED")]), runs([actionKind("hubspot.mark_customer", "rejected", 2)]))),
  check("duplicate_start", "A re-delivered close trigger does not post the report twice", [start("duplicate_start", input), startAgain("duplicate_start", input)], all(runs([eq("duplicateStarts", 1)]), runs([action("slack.post_report", "applied", 1, [eq("attempts", 1)])]))),
  check("concurrent_start", "Four simultaneous close triggers produce one run and one report", [start("concurrent_start", input, { runId: "{{run_id}}", concurrency: 4 })], all(runs([eq("duplicateStarts", 3)]), runs([action("slack.post_report", "applied", 1, [eq("attempts", 1)])]))),
  check("invalid_input_rejected", "A channel name instead of a channel id is rejected", [start("invalid_input_rejected", { financeChannel: "#finance" }, { expectStatus: 400 })], runs([], 0)),
  faulted("hubspot_auth_failure", "If HubSpot can't be read, nothing is reconciled or posted (no false variances)", "hubspot", "auth_failure", [agent("crm-ledger", "failed"), eq("phase", "DONE"), { select: "actions[*]", count: 0, required: true }]),
  faulted("hubspot_rate_limited", "HubSpot rate limiting past retries also stops the reconciliation rather than reporting a partial ledger", "hubspot", "rate_limited", [agent("crm-ledger", "failed"), { select: "actions[*]", count: 0, required: true }]),
  faulted("stripe_auth_failure", "If Stripe can't be read, nothing is reconciled or posted", "stripe", "auth_failure", [agent("stripe-ledger", "failed"), { select: "actions[*]", count: 0, required: true }]),
  faulted("slack_channel_not_found", "A Slack failure fails the report only; the CRM fixes still await approval", "slack", "channel_not_found", [action("slack.post_report", "failed"), actionKind("hubspot.mark_customer", "pending_approval", 2), eq("outcome", "partial")]),
  check("approve_and_reconcile", "Approved CRM fixes are applied and read back from HubSpot as matching", [start("approve_and_reconcile", input), command("decide", 1, { decision: "approve", userId: APPROVER }), command("reconcile", 1)], all(runs([eq("phase", "DONE")]), runs([actionKind("hubspot.mark_customer", "applied", 2, [eq("reconciled", "match")])]))),
  blocked("refund_approval_matching", "Every Stripe refund is matched to an approved Zendesk ticket; unmatched refunds are reported", "setup_missing", "FetchSandbox has no Zendesk twin yet; refunds are reported as unverified (refundsUnverified) instead of approved.", ["acme-ops/src/workflows/revenue-reconciliation.ts support-ledger", "validate_integration providers:[zendesk] → 'Unknown providers: zendesk'"]),
];

export default {
  workflow: "revenue-reconciliation",
  providers: ["stripe", "hubspot", "slack"],
  context: {
    goal: "Prove the revenue-reconciliation AgentCore runtime: Stripe ledger ‖ HubSpot ledger ‖ Zendesk refund approvals → variance report to Finance and gated CRM fixes, with read-back reconciliation.",
    workflow: "POST /invocations {action:start} reads the ledgers in parallel, posts the report and parks CRM fixes for approval; {action:decide} applies them; {action:reconcile} re-reads HubSpot. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records (phase, agents[], actions[] with status/attempts/reconciled) exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["approve_by_stranger_refused"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: "MRR is computed for the report but no amount is written anywhere.",
    duplicate_replay: ["duplicate_start"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: "A run is a point-in-time read of the ledgers; no event stream is consumed.",
    delayed_or_missing_events: "No inbound provider events.",
    provider_auth_and_scopes: ["hubspot_auth_failure", "stripe_auth_failure"],
    rate_limit_server_error_timeout: ["hubspot_rate_limited"],
    accepted_effect_response_loss: "Covered by side-effect claims in local tests.",
    partial_effects_and_recovery: ["slack_channel_not_found"],
    restart_and_durability: "Covered by local tests (test/engine.test.ts); not exercised through the relay.",
    reconciliation: ["approve_and_reconcile", "refund_approval_matching"],
    cancellation_refund_entitlements: ["reject", "refund_approval_matching"],
    data_and_privacy_boundaries: "Report goes only to the configured private Finance channel; no customer text is echoed.",
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: ["acme-ops/src/workflows/revenue-reconciliation.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/providers/{stripe,hubspot,slack}.ts"],
};
