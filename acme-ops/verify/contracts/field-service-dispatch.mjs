import { action, agent, all, blocked, check, command, eq, noAction, restart, runs, start, startAgain } from "./lib.mjs";

// Twin seed: alice@acmecorp.com has an active subscription (= service contract).
const CHANNEL = "C0INCIDENT";
const APPROVER = "U_FS_MANAGER";
const alarm = (caseId, over = {}) => ({
  alarm: { id: `ALM-${caseId}`, site: "Austin Substation 4", asset: "QTMS transformer monitor T2", severity: "critical", description: "Dissolved gas level above threshold." },
  account: { email: "alice@acmecorp.com" },
  sitePhone: "+15125550100",
  technicianCalendars: ["tech.rivera@acme.example", "tech.okafor@acme.example"],
  dispatchChannel: CHANNEL,
  approvers: [APPROVER],
  ...over,
});
const afterHours = (caseId) => alarm(caseId, { afterHours: true });
// The booking action exists only when a technician slot is found. A critical alarm searches one weekday of the
// shared technician calendars, which other checks book into, so whether anything parked depended on when the
// proof ran. A minor after-hours alarm on a calendar no other check books searches five weekdays and always parks.
const restartAlarm = alarm("restart", { afterHours: true, technicianCalendars: ["tech.restart-check@acme.example"], alarm: { ...alarm("restart").alarm, severity: "minor" } });
const notified = [action("asana.create_work_order", "applied"), action("twilio.notify_site", "applied"), action("slack.post_dispatch", "applied")];
const parked = [eq("phase", "AWAITING_APPROVAL"), action("calendar.book_technician", "pending_approval")];

function faulted(id, name, provider, scenario, assertions, input = alarm(id)) {
  return check(id, name, [start(id, input)], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });
}

export const checks = [
  check("baseline", "An in-hours alarm under contract opens the work order, texts the site, posts to Slack and books the technician automatically", [start("baseline", alarm("baseline"))], all(runs([eq("phase", "DONE"), eq("outcome", "ok")]), ...notified.map((a) => runs([a])), runs([action("calendar.book_technician", "applied")]))),
  check("after_hours_needs_approval", "An after-hours callout parks the booking for approval", [start("after_hours_needs_approval", afterHours("after_hours"))], all(runs(parked), ...notified.map((a) => runs([a])))),
  check("billable_needs_approval", "An alarm from a site without a service contract parks the (billable) booking for approval", [start("billable_needs_approval", alarm("billable", { account: { email: "plant-manager@initech.test" } }))], all(runs(parked))),
  check("approve_and_reconcile", "Approval books the technician; Asana and Twilio read back the work order and SMS", [start("approve_and_reconcile", afterHours("approve")), command("decide", 1, { decision: "approve", userId: APPROVER }), command("reconcile", 1)], all(runs([eq("phase", "DONE")]), runs([action("calendar.book_technician", "applied")]), runs([action("asana.create_work_order", "applied", 1, [eq("reconciled", "match")])]), runs([action("twilio.notify_site", "applied", 1, [eq("reconciled", "match")])]))),
  check("approve_by_stranger_refused", "A non-approver cannot authorize an after-hours callout", [start("approve_by_stranger_refused", afterHours("stranger")), command("decide", 1, { decision: "approve", userId: "U_TECH" }, 403)], all(runs(parked))),
  check("reject", "Rejecting leaves the visit unbooked; the work order stays open", [start("reject", afterHours("reject")), command("decide", 1, { decision: "reject", userId: APPROVER })], all(runs([eq("phase", "REJECTED")]), runs([action("calendar.book_technician", "rejected")]), runs([action("asana.create_work_order", "applied")]))),
  check("duplicate_start", "A re-delivered alarm opens one work order and sends one SMS", [start("duplicate_start", alarm("duplicate_start")), startAgain("duplicate_start", alarm("duplicate_start"))], all(runs([action("asana.create_work_order", "applied", 1, [eq("attempts", 1)])]), runs([action("twilio.notify_site", "applied", 1, [eq("attempts", 1)])]))),
  check("concurrent_start", "Four more simultaneous alarm deliveries open one work order and send one SMS", [start("concurrent_start", alarm("concurrent_start")), startAgain("concurrent_start", alarm("concurrent_start"), 1, 4)], all(runs([action("asana.create_work_order", "applied", 1, [eq("attempts", 1)])]), runs([action("twilio.notify_site", "applied", 1, [eq("attempts", 1)])]))),
  check("invalid_input_rejected", "A site phone that isn't E.164 is rejected before any agent runs", [start("invalid_input_rejected", alarm("invalid", { sitePhone: "512-555-0100" }), { expectStatus: 400 })], runs([], 0)),
  faulted("twilio_invalid_number", "Twilio refusing the number fails the SMS only; the work order and booking proceed", "twilio", "invalid_number", [action("twilio.notify_site", "failed"), action("asana.create_work_order", "applied"), action("calendar.book_technician", "applied"), eq("outcome", "partial")]),
  faulted("calendar_auth_failure", "Without technician calendars no booking is attempted; the work order and SMS still go out", "google-calendar", "auth_failure", [agent("technician-availability", "failed"), noAction("calendar.book_technician"), action("asana.create_work_order", "applied")]),
  faulted("stripe_auth_failure", "If the contract can't be verified the visit is treated as billable and parked for approval", "stripe", "auth_failure", [agent("service-contract", "failed"), eq("phase", "AWAITING_APPROVAL"), action("calendar.book_technician", "pending_approval")]),
  faulted("asana_rate_limited", "Asana rate limiting fails the work order only; the site is still texted", "asana", "rate_limited", [action("asana.create_work_order", "failed"), action("twilio.notify_site", "applied")]),
  check("restart_while_parked", "An after-hours booking parked for approval survives a runtime restart and is booked once approved", [start("restart_while_parked", restartAlarm), restart, command("decide", 1, { decision: "approve", userId: APPROVER })], all(runs([eq("phase", "DONE")]), runs([action("calendar.book_technician", "applied", 1, [eq("attempts", 1)])]))),
  blocked("parts_reservation", "Spare parts for the asset are reserved from inventory with the work order", "setup_missing", "No ERP/inventory twin (SAP/Oracle/NetSuite) in FetchSandbox; parts are listed in the work order for the technician to pick manually.", ["acme-ops/src/workflows/field-service-dispatch.ts asana.create_work_order", "validate_integration providers:[netsuite|sap] → 'Unknown providers'"]),
  blocked("calendar_booking_readback", "Reconciliation reads the booked visit back from the technician's calendar", "observation_missing", "The Calendar twin returns 404 on events.get right after a successful insert, so the booking can't be read back.", ["acme-ops/src/workflows/field-service-dispatch.ts calendar.book_technician", "GET /calendar/v3/calendars/{id}/events/{eventId} → 404 on the twin"]),
];

export default {
  workflow: "field-service-dispatch",
  providers: ["stripe", "hubspot", "slack", "asana", "twilio", "google-calendar"],
  context: {
    goal: "Prove the field-service-dispatch AgentCore runtime: asset alarm → parallel technician availability (Calendar), service contract (Stripe), site account (HubSpot) → work order, site SMS, Slack; booking gated when after-hours or billable.",
    workflow: "POST /invocations {action:start} plans the dispatch and applies auto actions; after-hours or billable bookings wait for {action:decide}; {action:reconcile} re-reads the work order and SMS.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["approve_by_stranger_refused"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: ["billable_needs_approval"],
    duplicate_replay: ["duplicate_start"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: "One trigger per alarm; availability is read at run start.",
    delayed_or_missing_events: "No inbound provider events.",
    provider_auth_and_scopes: ["calendar_auth_failure", "stripe_auth_failure"],
    rate_limit_server_error_timeout: ["asana_rate_limited"],
    accepted_effect_response_loss: "Covered by side-effect claims in local tests.",
    partial_effects_and_recovery: ["twilio_invalid_number"],
    restart_and_durability: ["restart_while_parked"],
    reconciliation: ["approve_and_reconcile", "calendar_booking_readback"],
    cancellation_refund_entitlements: ["reject"],
    data_and_privacy_boundaries: "The SMS carries only the alarm id, site and visit time.",
    cleanup_and_isolation: ["baseline", "concurrent_start", "parts_reservation"],
  },
  evidence: ["acme-ops/src/workflows/field-service-dispatch.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/providers/{stripe,hubspot,google,slack,work}.ts"],
};
