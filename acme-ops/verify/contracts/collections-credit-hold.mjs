import { action, actionKind, agent, all, check, command, eq, restart, runs, start, startAgain } from "./lib.mjs";

// Twin seed: dev@startupxyz.io has open invoice in_7EfG8hIjKl9mN0Op1Q, due
// 2025-01-22 ($49): far past 60 days → final tier, credit hold proposed.
// Approving the hold changes the customer (credit_hold=true), so the one
// approving check runs last; the restart check rejects.
const CHANNEL = "C0BILLING01";
const APPROVER = "U_AR_MANAGER";
const input = { arChannel: CHANNEL, approvers: [APPROVER] };
const parked = [eq("phase", "AWAITING_APPROVAL")];

function faulted(id, name, provider, scenario, assertions) {
  return check(id, name, [start(id, input)], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });
}

export const checks = [
  check("baseline", "Daily AR sweep: digest posted, tiered reminder drafted, credit hold on the 60+ day account waits for approval", [start("baseline", input)], all(runs([...parked, eq("outcome", "ok")]), runs([action("slack.post_ar_digest", "applied")]), runs([actionKind("gmail.draft_reminder", "applied", 1)]), runs([actionKind("stripe.credit_hold", "pending_approval", 1)]))),
  check("approve_by_stranger_refused", "A non-approver cannot put a customer on credit hold", [start("approve_by_stranger_refused", input), command("decide", 1, { decision: "approve", userId: "U_SALES_REP" }, 403)], all(runs(parked), runs([actionKind("stripe.credit_hold", "pending_approval", 1)]))),
  check("reject", "Rejecting leaves the account open for orders", [start("reject", input), command("decide", 1, { decision: "reject", userId: APPROVER })], all(runs([eq("phase", "REJECTED")]), runs([actionKind("stripe.credit_hold", "rejected", 1)]))),
  check("nothing_overdue_is_quiet", "When nothing is past the threshold, nothing is posted or drafted", [start("nothing_overdue_is_quiet", { ...input, asOf: "2025-01-01" })], all(runs([eq("phase", "DONE")]), runs([{ select: "actions[*]", count: 0, required: true }]))),
  check("invalid_input_rejected", "A channel name instead of a channel id is rejected", [start("invalid_input_rejected", { arChannel: "#ar" }, { expectStatus: 400 })], runs([], 0)),
  check("duplicate_start", "A re-fired schedule does not post or draft twice", [start("duplicate_start", input), startAgain("duplicate_start", input)], all(runs([action("slack.post_ar_digest", "applied", 1, [eq("attempts", 1)])]), runs([actionKind("gmail.draft_reminder", "applied", 1, [eq("attempts", 1)])]))),
  check("concurrent_start", "Four more simultaneous firings create one run", [start("concurrent_start", input), startAgain("concurrent_start", input, 1, 4)], all(runs([action("slack.post_ar_digest", "applied", 1, [eq("attempts", 1)])]))),
  faulted("stripe_auth_failure", "If Stripe can't be read, nothing is drafted, posted or held", "stripe", "auth_failure", [agent("ar-ledger", "failed"), { select: "actions[*]", count: 0, required: true }]),
  faulted("slack_rate_limited", "Slack rate limiting fails the digest only; the reminder and the hold proposal stand", "slack", "rate_limited", [action("slack.post_ar_digest", "failed"), actionKind("gmail.draft_reminder", "applied", 1), actionKind("stripe.credit_hold", "pending_approval", 1)]),
  faulted("gmail_auth_failure", "Gmail auth failure fails the reminder draft only", "gmail", "auth_failure", [actionKind("gmail.draft_reminder", "failed", 1), action("slack.post_ar_digest", "applied")]),
  faulted("hubspot_auth_failure", "Without HubSpot the owners are unknown, but collections still run", "hubspot", "auth_failure", [agent("account-owners", "failed"), action("slack.post_ar_digest", "applied"), actionKind("stripe.credit_hold", "pending_approval", 1)]),
  check("restart_while_parked", "A proposed hold survives a real runtime restart; the decision taken afterwards is honored", [start("restart_while_parked", input), restart, command("decide", 1, { decision: "reject", userId: APPROVER })], all(runs([eq("phase", "REJECTED")]), runs([actionKind("stripe.credit_hold", "rejected", 1)]))),
  check("approve_and_reconcile", "Approved hold is written to the Stripe customer and read back", [start("approve_and_reconcile", input), command("decide", 1, { decision: "approve", userId: APPROVER }), command("reconcile", 1)], all(runs([eq("phase", "DONE")]), runs([actionKind("stripe.credit_hold", "applied", 1, [eq("reconciled", "match")])]))),
];

export default {
  workflow: "collections-credit-hold",
  providers: ["stripe", "hubspot", "gmail", "slack"],
  context: {
    goal: "Prove the collections-credit-hold AgentCore runtime: Stripe AR ledger ‖ HubSpot owners → AR digest, tiered reminder drafts, gated credit hold with read-back.",
    workflow: "POST /invocations {action:start} reads open Stripe invoices, tiers them, posts the digest, drafts reminders and parks credit holds for approval; {action:decide} applies or withholds; {action:reconcile} re-reads the customer. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["approve_by_stranger_refused"],
    schema_and_value_boundaries: ["invalid_input_rejected", "nothing_overdue_is_quiet"],
    amount_currency_quantity: "Amounts are read and reported; nothing is charged or changed.",
    duplicate_replay: ["duplicate_start"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: "Point-in-time read of open invoices; no event stream.",
    delayed_or_missing_events: "No inbound provider events.",
    provider_auth_and_scopes: ["stripe_auth_failure", "gmail_auth_failure", "hubspot_auth_failure"],
    rate_limit_server_error_timeout: ["slack_rate_limited"],
    accepted_effect_response_loss: "Covered by side-effect claims in local tests.",
    partial_effects_and_recovery: ["slack_rate_limited", "gmail_auth_failure"],
    restart_and_durability: ["restart_while_parked"],
    reconciliation: ["approve_and_reconcile"],
    cancellation_refund_entitlements: ["reject", "approve_and_reconcile"],
    data_and_privacy_boundaries: "Reminders are drafts for human review; the digest goes to the internal AR channel.",
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: ["acme-ops/src/workflows/collections-credit-hold.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/providers/{stripe,hubspot,google,slack}.ts"],
};
