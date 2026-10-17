import { actionKind, agent, all, blocked, check, command, eq, restart, runs, start, startAgain } from "./lib.mjs";

// Twin seed: the WorkOS directory holds 3 users created 2026-01-15 that the
// user list reports as never signed in (~275 days idle on 2026-10-17). With the
// default policy (90 days + 14 grace) all 3 are reclaimable. The approving
// check runs LAST because it deletes them.
const CHANNEL = "C0GENERAL01";
const APPROVER = "U_IT_ASSETS";
const policy = (over = {}) => ({ itChannel: CHANNEL, approvers: [APPROVER], ...over });
const parked = [eq("phase", "AWAITING_APPROVAL")];
const none = { select: "actions[*]", count: 0, required: true };

function faulted(id, name, provider, scenario, input, assertions) {
  return check(id, name, [start(id, input)], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });
}

export const checks = [
  check("baseline", "Monthly scan posts the idle-seat summary and proposes reclaiming every seat idle past the grace period", [start("baseline", policy())], all(runs([...parked, eq("outcome", "ok")]), runs([actionKind("slack.post_summary", "applied")]), runs([actionKind("workos.reclaim_seat", "pending_approval", 3)]))),
  check("exclusions_respected", "Excluded accounts are never warned or reclaimed", [start("exclusions_respected", policy({ excludeEmails: ["marcelina.davis@example.com"] }))], runs([eq("phase", "DONE"), none])),
  check("within_policy_is_quiet", "Seats idle less than the policy produce no action", [start("within_policy_is_quiet", policy({ inactiveDays: 365, graceDays: 60 }))], runs([eq("phase", "DONE"), none])),
  check("warning_window", "Seats idle past the policy but inside the grace period get warning drafts, not reclaims", [start("warning_window", policy({ inactiveDays: 200, graceDays: 90 }))], all(runs([eq("phase", "DONE")]), runs([actionKind("gmail.draft_warning", "applied", 3)]), runs([actionKind("workos.reclaim_seat", null, 0)]))),
  check("approve_by_stranger_refused", "A non-approver cannot reclaim seats", [start("approve_by_stranger_refused", policy()), command("decide", 1, { decision: "approve", userId: "U_INTERN" }, 403)], all(runs(parked), runs([actionKind("workos.reclaim_seat", "pending_approval", 3)]))),
  check("reject", "Rejecting leaves every seat in place", [start("reject", policy()), command("decide", 1, { decision: "reject", userId: APPROVER })], all(runs([eq("phase", "REJECTED")]), runs([actionKind("workos.reclaim_seat", "rejected", 3)]))),
  check("duplicate_start", "A re-fired schedule does not post twice", [start("duplicate_start", policy()), startAgain("duplicate_start", policy())], runs([actionKind("slack.post_summary", "applied", 1, [eq("attempts", 1)])])),
  check("concurrent_start", "Four more simultaneous firings create one run", [start("concurrent_start", policy()), startAgain("concurrent_start", policy(), 1, 4)], runs([actionKind("slack.post_summary", "applied", 1, [eq("attempts", 1)])])),
  check("invalid_input_rejected", "A 3-day inactivity policy is rejected as too aggressive", [start("invalid_input_rejected", policy({ inactiveDays: 3 }), { expectStatus: 400 })], runs([], 0)),
  faulted("workos_auth_failure", "If the directory can't be read nothing is proposed", "workos", "auth_failure", policy(), [agent("directory-scan", "failed"), none]),
  faulted("slack_rate_limited", "A Slack failure loses the summary only; reclaims still await approval", "slack", "rate_limited", policy(), [actionKind("slack.post_summary", "failed"), actionKind("workos.reclaim_seat", "pending_approval", 3), eq("outcome", "partial")]),
  faulted("gmail_rate_limited", "A Gmail failure fails the warning drafts and is reported, not hidden", "gmail", "rate_limited", policy({ inactiveDays: 200, graceDays: 90 }), [actionKind("gmail.draft_warning", "failed", 3), eq("outcome", "partial")]),
  check("restart_while_parked", "A parked reclaim survives a runtime restart; the decision taken afterwards is honored", [start("restart_while_parked", policy()), restart, command("decide", 1, { decision: "reject", userId: APPROVER })], all(runs([eq("phase", "REJECTED")]), runs([actionKind("workos.reclaim_seat", "rejected", 3)]))),
  check("approve_and_reconcile", "Approved reclaims delete the idle accounts and reconcile proves each one is gone", [start("approve_and_reconcile", policy()), command("decide", 1, { decision: "approve", userId: APPROVER }), command("reconcile", 1)], runs([eq("phase", "DONE"), actionKind("workos.reclaim_seat", "applied", 3, [eq("reconciled", "match")])])),
  blocked("license_cost_savings", "Each reclaimed seat is priced from the vendor contract to report savings", "setup_missing", "No license-cost or contract system is connected (and no twin exists); the run reports seat counts only.", ["acme-ops/src/workflows/license-reclaim.ts output"]),
];

export default {
  workflow: "license-reclaim",
  providers: ["workos", "slack", "gmail"],
  context: {
    goal: "Prove the license-reclaim AgentCore runtime: WorkOS directory scan → idle-seat summary in Slack, warning drafts in Gmail, gated reclaim of seats idle past the grace period, reconcile proves the account is gone.",
    workflow: "POST /invocations {action:start} scans the directory and parks reclaims; {action:decide} applies them; {action:reconcile} re-reads WorkOS. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["approve_by_stranger_refused"],
    schema_and_value_boundaries: ["invalid_input_rejected", "within_policy_is_quiet", "warning_window"],
    amount_currency_quantity: ["license_cost_savings"],
    duplicate_replay: ["duplicate_start"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: ["approve_and_reconcile"],
    delayed_or_missing_events: "No inbound events; the schedule fires the run.",
    provider_auth_and_scopes: ["workos_auth_failure"],
    rate_limit_server_error_timeout: ["slack_rate_limited", "gmail_rate_limited"],
    accepted_effect_response_loss: "Covered by side-effect claims; a reclaim of an already-deleted account is treated as done.",
    partial_effects_and_recovery: ["slack_rate_limited", "gmail_rate_limited"],
    restart_and_durability: ["restart_while_parked"],
    reconciliation: ["approve_and_reconcile"],
    cancellation_refund_entitlements: ["reject", "exclusions_respected"],
    data_and_privacy_boundaries: "Idle-seat lists go to the internal IT channel only; warnings are drafts.",
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: ["acme-ops/src/workflows/license-reclaim.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/providers/work.ts WorkOSClient"],
};
