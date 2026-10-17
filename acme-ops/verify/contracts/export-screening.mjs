import { action, actionKind, agent, all, blocked, check, command, eq, restart, runs, start, startAgain } from "./lib.mjs";

// There is no restricted-party screening twin, so the screening agent is
// skipped and every order is HELD (fail-safe) — that path is what this
// contract proves. alice@acmecorp.com is the seeded Stripe customer.
const CHANNEL = "C0GENERAL01";
const APPROVER = "U_EXPORT_OFFICER";
const order = (over = {}) => ({
  orderRef: "SO-1001",
  customerEmail: "alice@acmecorp.com",
  partyName: "Acme Corp",
  shipToCountry: "DE",
  endUse: "Utility substation transformer monitoring",
  productIds: ["prod_SaaS_ProPlan"],
  complianceChannel: CHANNEL,
  approvers: [APPROVER],
  ...over,
});
const parked = [eq("phase", "AWAITING_APPROVAL")];

function faulted(id, name, provider, scenario, assertions) {
  return check(id, name, [start(id, order())], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });
}

export const checks = [
  check("baseline", "An order that can't be fully screened is held: account flagged, review opened, channel alerted; release waits for approval", [start("baseline", order())], all(runs([...parked, eq("outcome", "ok")]), runs([agent("party-screening", "skipped")]), runs([action("stripe.place_export_hold", "applied")]), runs([action("asana.compliance_review", "applied")]), runs([action("slack.post_hold_alert", "applied")]), runs([actionKind("stripe.release_export_hold", "pending_approval", 1)]))),
  check("embargoed_destination_cannot_be_released", "An order to an embargoed destination is held and offers no release", [start("embargoed_destination_cannot_be_released", order({ orderRef: "SO-1002", shipToCountry: "IR" }))], all(runs([eq("phase", "DONE")]), runs([action("stripe.place_export_hold", "applied")]), runs([actionKind("stripe.release_export_hold", null, 0)]))),
  check("unknown_customer_still_reviewed", "An unknown buyer gets a review and an alert even with no account to flag", [start("unknown_customer_still_reviewed", order({ orderRef: "SO-1003", customerEmail: "buyer@unknown-co.test" }))], all(runs([eq("phase", "DONE")]), runs([action("asana.compliance_review", "applied")]), runs([actionKind("stripe.place_export_hold", null, 0)]))),
  check("approve_by_stranger_refused", "A non-officer cannot release a hold", [start("approve_by_stranger_refused", order()), command("decide", 1, { decision: "approve", userId: "U_SALES_REP" }, 403)], all(runs(parked), runs([actionKind("stripe.release_export_hold", "pending_approval", 1)]))),
  check("reject", "Rejecting keeps the hold", [start("reject", order()), command("decide", 1, { decision: "reject", userId: APPROVER })], all(runs([eq("phase", "REJECTED")]), runs([actionKind("stripe.release_export_hold", "rejected", 1)]))),
  check("invalid_input_rejected", "A country name instead of an ISO code is rejected", [start("invalid_input_rejected", order({ shipToCountry: "Germany" }), { expectStatus: 400 })], runs([], 0)),
  check("duplicate_start", "A re-delivered order event does not open a second review", [start("duplicate_start", order()), startAgain("duplicate_start", order())], all(runs([action("asana.compliance_review", "applied", 1, [eq("attempts", 1)])]))),
  check("concurrent_start", "Four more simultaneous deliveries create one run", [start("concurrent_start", order()), startAgain("concurrent_start", order(), 1, 4)], all(runs([action("asana.compliance_review", "applied", 1, [eq("attempts", 1)])]))),
  faulted("stripe_auth_failure", "Without Stripe the items can't be classified: still held, reviewed and alerted", "stripe", "auth_failure", [agent("item-classification", "failed"), action("asana.compliance_review", "applied"), action("slack.post_hold_alert", "applied")]),
  faulted("asana_auth_failure", "Asana failure fails the review task only; the hold stands", "asana", "auth_failure", [action("asana.compliance_review", "failed"), action("stripe.place_export_hold", "applied")]),
  faulted("slack_channel_not_found", "Slack failure fails the alert only; the hold stands", "slack", "channel_not_found", [action("slack.post_hold_alert", "failed"), action("stripe.place_export_hold", "applied")]),
  check("restart_while_parked", "A held order survives a real runtime restart; the officer's decision afterwards is honored", [start("restart_while_parked", order()), restart, command("decide", 1, { decision: "reject", userId: APPROVER })], all(runs([eq("phase", "REJECTED")]), runs([actionKind("stripe.release_export_hold", "rejected", 1)]))),
  check("approve_and_reconcile", "The officer's release clears the hold and the read-back confirms it", [start("approve_and_reconcile", order()), command("decide", 1, { decision: "approve", userId: APPROVER }), command("reconcile", 1)], all(runs([eq("phase", "DONE")]), runs([actionKind("stripe.release_export_hold", "applied", 1, [eq("reconciled", "match")])]))),
  blocked("restricted_party_screening", "Parties are screened against the restricted-party lists and a clean order is cleared automatically", "setup_missing", "No FetchSandbox twin for the Trade.gov Consolidated Screening List (or any screening provider); the runtime treats screening as unavailable and holds every order.", ["acme-ops/src/providers/work.ts ScreeningClient (GET /consolidated_screening_list/v1/search)", "validate_integration has no screening provider"]),
];

export default {
  workflow: "export-screening",
  providers: ["stripe", "slack", "asana"],
  context: {
    goal: "Prove the export-screening AgentCore runtime: item classification ‖ restricted-party screening ‖ customer record → fail-safe hold, review task, alert; release gated with read-back.",
    workflow: "POST /invocations {action:start} screens the order and holds it unless confirmed clean; {action:decide} releases or keeps the hold; {action:reconcile} re-reads the customer. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["approve_by_stranger_refused", "embargoed_destination_cannot_be_released"],
    schema_and_value_boundaries: ["invalid_input_rejected", "unknown_customer_still_reviewed"],
    amount_currency_quantity: "No amounts involved.",
    duplicate_replay: ["duplicate_start"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: "Each order is decided on a fresh read; a release never applies to an embargoed destination.",
    delayed_or_missing_events: ["baseline", "restricted_party_screening"],
    provider_auth_and_scopes: ["stripe_auth_failure", "asana_auth_failure"],
    rate_limit_server_error_timeout: "Exercised by other contracts through the shared retry path.",
    accepted_effect_response_loss: "Covered by side-effect claims in local tests.",
    partial_effects_and_recovery: ["asana_auth_failure", "slack_channel_not_found"],
    restart_and_durability: ["restart_while_parked"],
    reconciliation: ["approve_and_reconcile"],
    cancellation_refund_entitlements: ["reject"],
    data_and_privacy_boundaries: "Party names go only to the screening service and the internal compliance channel.",
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: ["acme-ops/src/workflows/export-screening.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/providers/{stripe,slack,work}.ts"],
};
