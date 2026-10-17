import { actionKind, agent, all, blocked, check, command, eq, runs, start, startAgain } from "./lib.mjs";

// Twin seed: dev@startupxyz.io is past due with an open invoice and no CRM
// record → high risk. alice@acmecorp.com is active → low risk.
const CHANNEL = "C0BILLING01";
const APPROVER = "U_CS_LEAD";
const book = { accounts: [{ email: "alice@acmecorp.com", name: "Alice Johnson" }, { email: "dev@startupxyz.io", name: "Dev Patel" }], csChannel: CHANNEL, approvers: [APPROVER] };
const parked = [eq("phase", "AWAITING_APPROVAL")];

function faulted(id, name, provider, scenario, assertions) {
  return check(id, name, [start(id, book)], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });
}

export const checks = [
  check("baseline", "Weekly sweep flags the past-due account: digest posted, check-in drafted, QBR invite waits for approval", [start("baseline", book)], all(runs([...parked, eq("outcome", "ok")]), runs([actionKind("slack.post_digest", "applied")]), runs([actionKind("gmail.draft_checkin", "applied", 1)]), runs([actionKind("calendar.book_qbr", "pending_approval", 1)]))),
  check("approve_by_approver", "Approval sends the QBR invite", [start("approve_by_approver", book), command("decide", 1, { decision: "approve", userId: APPROVER })], all(runs([eq("phase", "DONE")]), runs([actionKind("calendar.book_qbr", "applied", 1)]))),
  check("approve_by_stranger_refused", "A non-approver cannot send customer invites", [start("approve_by_stranger_refused", book), command("decide", 1, { decision: "approve", userId: "U_SOMEONE" }, 403)], all(runs(parked), runs([actionKind("calendar.book_qbr", "pending_approval", 1)]))),
  check("reject", "Rejecting withholds the invite", [start("reject", book), command("decide", 1, { decision: "reject", userId: APPROVER })], all(runs([eq("phase", "REJECTED")]), runs([actionKind("calendar.book_qbr", "rejected", 1)]))),
  check("healthy_book_is_quiet", "A book with no at-risk accounts posts nothing and drafts nothing", [start("healthy_book_is_quiet", { accounts: [{ email: "alice@acmecorp.com" }], csChannel: CHANNEL })], all(runs([eq("phase", "DONE")]), runs([{ select: "actions[*]", count: 0, required: true }]))),
  check("invalid_input_rejected", "Duplicate accounts in one sweep are rejected", [start("invalid_input_rejected", { accounts: [{ email: "a@b.co" }, { email: "A@b.co" }], csChannel: CHANNEL }, { expectStatus: 400 })], runs([], 0)),
  check("duplicate_start", "A re-fired schedule does not post the digest twice", [start("duplicate_start", book), startAgain("duplicate_start", book)], all(runs([eq("duplicateStarts", 1)]), runs([actionKind("slack.post_digest", "applied", 1, [eq("attempts", 1)])]))),
  check("concurrent_start", "Four simultaneous schedule firings create one run", [start("concurrent_start", book, { runId: "{{run_id}}", concurrency: 4 })], all(runs([eq("duplicateStarts", 3)]), runs([actionKind("gmail.draft_checkin", "applied", 1, [eq("attempts", 1)])]))),
  faulted("stripe_auth_failure", "Without billing data the sweep reports the gap instead of calling the account healthy", "stripe", "auth_failure", [agent("billing-signal", "failed"), eq("outcome", "partial")]),
  faulted("slack_rate_limited", "Slack rate limiting fails the digest only; the check-in draft is still created", "slack", "rate_limited", [actionKind("slack.post_digest", "failed"), actionKind("gmail.draft_checkin", "applied", 1)]),
  faulted("calendar_auth_failure", "Without the CSM's calendar no invite is proposed; drafts and digest continue", "google-calendar", "auth_failure", [agent("csm-availability", "failed"), actionKind("calendar.book_qbr", null, 0), actionKind("slack.post_digest", "applied")]),
  faulted("gmail_auth_failure", "Gmail auth failure loses the inbox signal and the draft, but the account is still flagged", "gmail", "auth_failure", [agent("inbox-signal", "failed"), actionKind("gmail.draft_checkin", "failed", 1), actionKind("calendar.book_qbr", "pending_approval", 1)]),
  blocked("support_signal", "Open and urgent Zendesk tickets raise the account's risk score", "setup_missing", "FetchSandbox has no Zendesk twin yet; the support signal is reported in signalGaps.", ["acme-ops/src/workflows/churn-risk-sweep.ts support-signal", "validate_integration providers:[zendesk] → 'Unknown providers: zendesk'"]),
];

export default {
  workflow: "churn-risk-sweep",
  providers: ["stripe", "hubspot", "gmail", "google-calendar", "slack"],
  context: {
    goal: "Prove the churn-risk-sweep AgentCore runtime: Stripe ‖ HubSpot ‖ Zendesk ‖ Gmail signals and CSM availability → risk scores, CS digest, check-in drafts, gated QBR invites.",
    workflow: "POST /invocations {action:start} gathers signals in parallel, scores accounts, posts the digest, drafts check-ins and parks QBR invites; {action:decide} sends or withholds invites. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["approve_by_stranger_refused", "approve_by_approver"],
    schema_and_value_boundaries: ["invalid_input_rejected", "healthy_book_is_quiet"],
    amount_currency_quantity: "No amounts are written.",
    duplicate_replay: ["duplicate_start"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: "Point-in-time read of each signal; no event stream.",
    delayed_or_missing_events: "No inbound provider events.",
    provider_auth_and_scopes: ["stripe_auth_failure", "calendar_auth_failure", "gmail_auth_failure"],
    rate_limit_server_error_timeout: ["slack_rate_limited"],
    accepted_effect_response_loss: "Covered by side-effect claims in local tests.",
    partial_effects_and_recovery: ["slack_rate_limited", "gmail_auth_failure"],
    restart_and_durability: "Covered by local tests (test/engine.test.ts); not exercised through the relay.",
    reconciliation: ["support_signal"],
    cancellation_refund_entitlements: ["reject"],
    data_and_privacy_boundaries: "Check-in drafts never mention scores or overdue payments; the digest goes to the internal CS channel only.",
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: ["acme-ops/src/workflows/churn-risk-sweep.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/providers/{stripe,hubspot,google,slack}.ts"],
};
