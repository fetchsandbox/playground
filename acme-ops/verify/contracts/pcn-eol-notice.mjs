import { action, actionKind, agent, all, check, command, eq, restart, runs, start, startAgain } from "./lib.mjs";

// Twin seed: the Pro product (prod_SaaS_ProPlan) has two customers on live
// subscriptions (alice@acmecorp.com, dev@startupxyz.io); neither has a HubSpot
// owner, so follow-up goes to one "unassigned" task. Each run opens its own
// GitHub change record (the GitHub twin starts empty).
const CHANNEL = "C0GENERAL01";
const APPROVER = "U_VP_ENGINEERING";
const input = (over = {}) => ({
  repo: "acme/plm",
  productId: "prod_SaaS_ProPlan",
  kind: "end_of_life",
  title: "Gen-2 level switch reaches end of life",
  summary: "The Gen-2 level switch is replaced by Gen-3 (form-fit compatible). Orders after the last-time-buy date ship Gen-3.",
  effectiveDate: "2027-03-31",
  lastTimeBuy: "2027-01-31",
  notifyChannel: CHANNEL,
  approvers: [APPROVER],
  ...over,
});
const parked = [eq("phase", "AWAITING_APPROVAL")];

function faulted(id, name, provider, scenario, assertions) {
  return check(id, name, [start(id, input())], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });
}

export const checks = [
  check("baseline", "EOL record opened, affected customers posted, owner task created; customer notices and marking the record wait for approval", [start("baseline", input())], all(runs([...parked, eq("outcome", "ok")]), runs([action("github.open_change_record", "applied")]), runs([action("slack.post_change_summary", "applied")]), runs([actionKind("asana.owner_task", "applied", 1)]), runs([actionKind("gmail.draft_customer_notice", "pending_approval", 2)]), runs([action("github.mark_customers_notified", "pending_approval")]))),
  check("approve_and_reconcile", "Approval prepares the notices and labels the record; read-back confirms the label", [start("approve_and_reconcile", input()), command("decide", 1, { decision: "approve", userId: APPROVER }), command("reconcile", 1)], all(runs([eq("phase", "DONE")]), runs([actionKind("gmail.draft_customer_notice", "applied", 2)]), runs([action("github.mark_customers_notified", "applied", 1, [eq("reconciled", "match")])]))),
  check("unreadable_record_sends_nothing", "If the named change record can't be read, nothing is posted or prepared", [start("unreadable_record_sends_nothing", input({ issueNumber: 987654 }))], all(runs([agent("change-record", "failed")]), runs([{ select: "actions[*]", count: 0, required: true }]))),
  check("unknown_product_sends_nothing", "An unknown product finds no customers and prepares nothing", [start("unknown_product_sends_nothing", input({ productId: "prod_DoesNotExist" }))], all(runs([agent("affected-customers", "failed")]), runs([{ select: "actions[*]", count: 0, required: true }]))),
  check("approve_by_stranger_refused", "A non-approver cannot release customer notices", [start("approve_by_stranger_refused", input()), command("decide", 1, { decision: "approve", userId: "U_INTERN" }, 403)], all(runs(parked), runs([action("github.mark_customers_notified", "pending_approval")]))),
  check("reject", "Rejecting prepares no customer notices", [start("reject", input()), command("decide", 1, { decision: "reject", userId: APPROVER })], all(runs([eq("phase", "REJECTED")]), runs([actionKind("gmail.draft_customer_notice", "rejected", 2)]))),
  check("invalid_input_rejected", "A malformed repository name is rejected", [start("invalid_input_rejected", input({ repo: "not a repo" }), { expectStatus: 400 })], runs([], 0)),
  check("duplicate_start", "A re-delivered change does not open a second record", [start("duplicate_start", input()), startAgain("duplicate_start", input())], all(runs([action("github.open_change_record", "applied", 1, [eq("attempts", 1)])]))),
  check("concurrent_start", "Four more simultaneous deliveries open one record", [start("concurrent_start", input()), startAgain("concurrent_start", input(), 1, 4)], all(runs([action("github.open_change_record", "applied", 1, [eq("attempts", 1)])]))),
  faulted("github_auth_failure", "GitHub auth failure fails opening the record; internal follow-up continues", "github", "auth_failure", [action("github.open_change_record", "failed"), action("slack.post_change_summary", "applied")]),
  faulted("asana_rate_limited", "Asana rate limiting fails the owner task only", "asana", "rate_limited", [actionKind("asana.owner_task", "failed", 1), action("slack.post_change_summary", "applied")]),
  faulted("stripe_auth_failure", "Without Stripe the affected customers are unknown, so nothing is prepared", "stripe", "auth_failure", [agent("affected-customers", "failed"), { select: "actions[*]", count: 0, required: true }]),
  check("restart_while_parked", "A pending notice run survives a real runtime restart and completes when approved afterwards", [start("restart_while_parked", input()), restart, command("decide", 1, { decision: "approve", userId: APPROVER })], all(runs([eq("phase", "DONE")]), runs([action("github.mark_customers_notified", "applied")]))),
];

export default {
  workflow: "pcn-eol-notice",
  providers: ["github", "stripe", "hubspot", "slack", "asana", "gmail"],
  context: {
    goal: "Prove the pcn-eol-notice AgentCore runtime: GitHub change record ‖ Stripe affected customers ‖ HubSpot owners → record, summary, owner tasks; gated customer notice drafts and record labelling with read-back.",
    workflow: "POST /invocations {action:start} reads or opens the change record, finds affected customers, posts and creates tasks, parks notices; {action:decide} prepares them and labels the record; {action:reconcile} re-reads the label. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["approve_by_stranger_refused"],
    schema_and_value_boundaries: ["invalid_input_rejected", "unknown_product_sends_nothing", "unreadable_record_sends_nothing"],
    amount_currency_quantity: "No amounts involved.",
    duplicate_replay: ["duplicate_start"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: "The record is labelled only after the notices are prepared (plan order).",
    delayed_or_missing_events: "No inbound provider events.",
    provider_auth_and_scopes: ["github_auth_failure", "stripe_auth_failure"],
    rate_limit_server_error_timeout: ["asana_rate_limited"],
    accepted_effect_response_loss: "Covered by side-effect claims in local tests.",
    partial_effects_and_recovery: ["github_auth_failure", "asana_rate_limited"],
    restart_and_durability: ["restart_while_parked"],
    reconciliation: ["approve_and_reconcile"],
    cancellation_refund_entitlements: ["reject"],
    data_and_privacy_boundaries: "Customer notices are drafts; nothing reaches a customer without approval and a human send.",
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: ["acme-ops/src/workflows/pcn-eol-notice.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/providers/{stripe,hubspot,google,slack,work}.ts"],
};
