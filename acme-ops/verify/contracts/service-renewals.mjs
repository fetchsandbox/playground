import { action, actionKind, agent, all, check, command, eq, restart, runs, start, startAgain } from "./lib.mjs";

// Twin seed: two monthly Pro subscriptions — alice@acmecorp.com (active) and
// dev@startupxyz.io (past_due) — both renew within 30 days. A 7% uplift is
// above the 5% policy, so alice's uplift waits for approval; dev gets none
// (past due: collect first).
const CHANNEL = "C0GENERAL01";
const APPROVER = "U_CS_DIRECTOR";
const input = { csChannel: CHANNEL, upliftPct: 7, maxAutoUpliftPct: 5, approvers: [APPROVER] };
const parked = [eq("phase", "AWAITING_APPROVAL")];

function faulted(id, name, provider, scenario, assertions) {
  return check(id, name, [start(id, input)], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });
}

export const checks = [
  check("baseline", "Renewal sweep: owner tasks, renewal drafts and digest for both renewing contracts; the above-policy uplift waits for approval", [start("baseline", input)], all(runs([...parked, eq("outcome", "ok")]), runs([action("slack.post_renewal_digest", "applied")]), runs([actionKind("asana.renewal_task", "applied", 2)]), runs([actionKind("gmail.draft_renewal", "applied", 2)]), runs([actionKind("stripe.schedule_uplift", "pending_approval", 1)]))),
  check("uplift_within_policy_is_automatic", "A 3% uplift (within the 5% policy) is scheduled without approval", [start("uplift_within_policy_is_automatic", { ...input, upliftPct: 3 })], all(runs([eq("phase", "DONE")]), runs([actionKind("stripe.schedule_uplift", "applied", 1)]))),
  check("no_uplift_past_due", "No uplift is proposed for a past-due account", [start("no_uplift_past_due", { ...input, accounts: ["dev@startupxyz.io"] })], all(runs([eq("phase", "DONE")]), runs([actionKind("asana.renewal_task", "applied", 1)]), runs([actionKind("stripe.schedule_uplift", null, 0)]))),
  check("approve_by_stranger_refused", "A non-approver cannot raise a customer's price", [start("approve_by_stranger_refused", input), command("decide", 1, { decision: "approve", userId: "U_INTERN" }, 403)], all(runs(parked), runs([actionKind("stripe.schedule_uplift", "pending_approval", 1)]))),
  check("reject", "Rejecting keeps the current price", [start("reject", input), command("decide", 1, { decision: "reject", userId: APPROVER })], all(runs([eq("phase", "REJECTED")]), runs([actionKind("stripe.schedule_uplift", "rejected", 1)]))),
  check("invalid_input_rejected", "An 80% uplift is rejected before any agent runs", [start("invalid_input_rejected", { ...input, upliftPct: 80 }, { expectStatus: 400 })], runs([], 0)),
  check("duplicate_start", "A re-fired schedule does not create tasks or drafts twice", [start("duplicate_start", input), startAgain("duplicate_start", input)], all(runs([actionKind("asana.renewal_task", "applied", 2, [eq("attempts", 1)])]), runs([action("slack.post_renewal_digest", "applied", 1, [eq("attempts", 1)])]))),
  check("concurrent_start", "Four more simultaneous firings create one run", [start("concurrent_start", input), startAgain("concurrent_start", input, 1, 4)], all(runs([actionKind("asana.renewal_task", "applied", 2, [eq("attempts", 1)])]))),
  faulted("stripe_auth_failure", "If Stripe can't be read, nothing is created", "stripe", "auth_failure", [agent("renewal-ledger", "failed"), { select: "actions[*]", count: 0, required: true }]),
  faulted("asana_auth_failure", "Asana auth failure fails the owner tasks only; drafts and digest continue", "asana", "auth_failure", [actionKind("asana.renewal_task", "failed", 2), actionKind("gmail.draft_renewal", "applied", 2), eq("outcome", "partial")]),
  faulted("calendar_auth_failure", "Without the CSM calendar the drafts go out without a proposed call time", "google-calendar", "auth_failure", [agent("renewal-call-slots", "failed"), actionKind("gmail.draft_renewal", "applied", 2)]),
  check("restart_while_parked", "A pending uplift survives a real runtime restart and is applied when approved afterwards", [start("restart_while_parked", input), restart, command("decide", 1, { decision: "approve", userId: APPROVER })], all(runs([eq("phase", "DONE")]), runs([actionKind("stripe.schedule_uplift", "applied", 1)]))),
  check("approve_and_reconcile", "Approved uplift is written to the subscription and read back", [start("approve_and_reconcile", input), command("decide", 1, { decision: "approve", userId: APPROVER }), command("reconcile", 1)], all(runs([eq("phase", "DONE")]), runs([actionKind("stripe.schedule_uplift", "applied", 1, [eq("reconciled", "match")])]))),
];

export default {
  workflow: "service-renewals",
  providers: ["stripe", "hubspot", "gmail", "google-calendar", "slack", "asana"],
  context: {
    goal: "Prove the service-renewals AgentCore runtime: Stripe subscriptions ‖ HubSpot ‖ CSM calendar → renewal tasks, drafts, digest; uplift gated above policy; subscription read-back.",
    workflow: "POST /invocations {action:start} sweeps renewing subscriptions, creates Asana tasks, Gmail drafts and a Slack digest, schedules or parks uplifts; {action:decide} applies or withholds; {action:reconcile} re-reads the subscription. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["approve_by_stranger_refused"],
    schema_and_value_boundaries: ["invalid_input_rejected", "uplift_within_policy_is_automatic"],
    amount_currency_quantity: ["uplift_within_policy_is_automatic", "approve_and_reconcile"],
    duplicate_replay: ["duplicate_start"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: "Point-in-time sweep; no event stream.",
    delayed_or_missing_events: "No inbound provider events.",
    provider_auth_and_scopes: ["stripe_auth_failure", "asana_auth_failure", "calendar_auth_failure"],
    rate_limit_server_error_timeout: "Rate limits are covered by the shared retry path in other workflows; this contract exercises auth failures.",
    accepted_effect_response_loss: "Covered by side-effect claims in local tests.",
    partial_effects_and_recovery: ["asana_auth_failure"],
    restart_and_durability: ["restart_while_parked"],
    reconciliation: ["approve_and_reconcile"],
    cancellation_refund_entitlements: ["reject", "no_uplift_past_due"],
    data_and_privacy_boundaries: "Renewal emails are drafts for the CSM; nothing is sent automatically.",
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: ["acme-ops/src/workflows/service-renewals.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/providers/{stripe,hubspot,google,slack,work}.ts"],
};
