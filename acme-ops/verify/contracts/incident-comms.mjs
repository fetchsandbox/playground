import { action, actionKind, agent, all, blocked, check, command, eq, restart, runs, start, startAgain } from "./lib.mjs";

// Twin seed: two Stripe customers hold live subscriptions (alice active,
// dev past_due), so a service-wide high-urgency incident affects 2 customers.
const CHANNEL = "C0INCIDENT";
const APPROVER = "U_INCIDENT_CMDR";
const incident = (id, over = {}, incOver = {}) => ({
  incident: { id: `P${id.replaceAll("_", "").toUpperCase()}`.slice(0, 20), title: "Monitoring API returning 503", service: "ACME Cloud Monitoring", urgency: "high", status: "triggered", ...incOver },
  warRoomChannel: CHANNEL,
  approvers: [APPROVER],
  ...over,
});
const parked = [eq("phase", "AWAITING_APPROVAL")];
const NOTICE = "gmail.draft_customer_notice";

function faulted(id, name, provider, scenario, assertions) {
  return check(id, name, [start(id, incident(id))], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });
}

export const checks = [
  check("baseline", "A high-urgency incident updates the war room and the incident timeline, and drafts a notice per affected customer for approval", [start("baseline", incident("baseline"))], all(runs([...parked, eq("outcome", "ok")]), runs([action("slack.war_room_update", "applied")]), runs([action("pagerduty.timeline_note", "applied")]), runs([actionKind(NOTICE, "pending_approval", 2)]))),
  check("low_urgency_internal", "A low-urgency incident stays internal: no customer notices", [start("low_urgency_internal", incident("lowurg", {}, { urgency: "low" }))], all(runs([eq("phase", "DONE")]), runs([actionKind(NOTICE, null, 0)]), runs([action("slack.war_room_update", "applied")]))),
  check("resolution_notices", "A resolved incident drafts resolution notices for approval", [start("resolution_notices", incident("resolved", {}, { status: "resolved" }))], all(runs(parked), runs([actionKind(NOTICE, "pending_approval", 2)]))),
  check("approve_by_commander", "The incident commander's approval creates the customer drafts", [start("approve_by_commander", incident("approved")), command("decide", 1, { decision: "approve", userId: APPROVER })], all(runs([eq("phase", "DONE")]), runs([actionKind(NOTICE, "applied", 2)]))),
  check("approve_by_stranger_refused", "Someone outside the incident cannot release customer notices", [start("approve_by_stranger_refused", incident("stranger")), command("decide", 1, { decision: "approve", userId: "U_ENGINEER" }, 403)], all(runs(parked), runs([actionKind(NOTICE, "pending_approval", 2)]))),
  check("reject", "Rejecting withholds every customer notice", [start("reject", incident("rejected")), command("decide", 1, { decision: "reject", userId: APPROVER })], all(runs([eq("phase", "REJECTED")]), runs([actionKind(NOTICE, "rejected", 2)]))),
  check("duplicate_start", "A re-delivered PagerDuty webhook does not post twice", [start("duplicate_start", incident("duplicate")), startAgain("duplicate_start", incident("duplicate"))], runs([action("slack.war_room_update", "applied", 1, [eq("attempts", 1)])])),
  check("concurrent_start", "Four more simultaneous webhook deliveries create one run", [start("concurrent_start", incident("concurrent")), startAgain("concurrent_start", incident("concurrent"), 1, 4)], runs([action("pagerduty.timeline_note", "applied", 1, [eq("attempts", 1)])])),
  check("invalid_input_rejected", "A malformed incident id is rejected before anything runs", [start("invalid_input_rejected", incident("invalid", {}, { id: "not-an-id" }), { expectStatus: 400 })], runs([], 0)),
  faulted("stripe_auth_failure", "If billing can't be read, the war room hears 'impact unknown' and no customer is notified", "stripe", "auth_failure", [agent("customer-impact", "failed"), action("slack.war_room_update", "applied"), actionKind(NOTICE, null, 0)]),
  faulted("hubspot_rate_limited", "Losing CRM owners doesn't stop customer notices", "hubspot", "rate_limited", [agent("account-owners", "failed"), actionKind(NOTICE, "pending_approval", 2)]),
  faulted("slack_auth_failure", "A Slack failure loses the war-room post only", "slack", "auth_failure", [action("slack.war_room_update", "failed"), action("pagerduty.timeline_note", "applied"), eq("outcome", "partial")]),
  faulted("pagerduty_rate_limited", "A PagerDuty failure loses the timeline note only", "pagerduty", "rate_limited", [action("pagerduty.timeline_note", "failed"), action("slack.war_room_update", "applied")]),
  check("restart_while_parked", "Notices parked for approval survive a runtime restart and are drafted when approved afterwards", [start("restart_while_parked", incident("restart")), restart, command("decide", 1, { decision: "approve", userId: APPROVER })], runs([eq("phase", "DONE"), actionKind(NOTICE, "applied", 2)])),
  blocked("status_page_update", "The public status page is updated with the incident", "setup_missing", "There is no Statuspage (or equivalent) twin; the runtime does not write to a status page.", ["acme-ops/src/workflows/incident-comms.ts catalog"]),
  blocked("affected_by_product", "Only customers on the affected products are notified", "setup_missing", "Seeded Stripe twin subscription items carry no price/product, so a product-scoped incident matches nobody; service-wide incidents are proven instead.", ["acme-ops/src/workflows/incident-comms.ts customer-impact", "Stripe twin seeded subscriptions lack items.data[].price"]),
  blocked("pagerduty_note_readback", "The timeline note is read back from the incident", "setup_missing", "The PagerDuty twin's GET /incidents/{id}/notes returns sample notes rather than the note written.", ["acme-ops/src/providers/work.ts PagerDutyClient.addNote"]),
];

export default {
  workflow: "incident-comms",
  providers: ["stripe", "hubspot", "slack", "gmail", "pagerduty"],
  context: {
    goal: "Prove the incident-comms AgentCore runtime: PagerDuty incident → affected customers from Stripe ‖ CRM owners from HubSpot → war-room post in Slack, timeline note in PagerDuty, gated customer notice drafts in Gmail.",
    workflow: "POST /invocations {action:start} computes impact, posts internal updates and parks customer notices; {action:decide} drafts or withholds them. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["approve_by_stranger_refused", "approve_by_commander"],
    schema_and_value_boundaries: ["invalid_input_rejected", "low_urgency_internal"],
    amount_currency_quantity: "No amounts are involved.",
    duplicate_replay: ["duplicate_start"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: ["resolution_notices"],
    delayed_or_missing_events: "The control plane delivers the PagerDuty webhook synchronously; signature handling is the control plane's.",
    provider_auth_and_scopes: ["stripe_auth_failure", "slack_auth_failure"],
    rate_limit_server_error_timeout: ["hubspot_rate_limited", "pagerduty_rate_limited"],
    accepted_effect_response_loss: "Covered by side-effect claims.",
    partial_effects_and_recovery: ["slack_auth_failure", "pagerduty_rate_limited"],
    restart_and_durability: ["restart_while_parked"],
    reconciliation: ["pagerduty_note_readback", "affected_by_product"],
    cancellation_refund_entitlements: ["reject"],
    data_and_privacy_boundaries: ["stripe_auth_failure", "status_page_update"],
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: ["acme-ops/src/workflows/incident-comms.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/providers/work.ts PagerDutyClient", "acme-ops/src/providers/stripe.ts"],
};
