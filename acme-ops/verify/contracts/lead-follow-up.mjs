import { restart, action, agent, all, blocked, check, command, eq, noAction, runs, start, startAgain } from "./lib.mjs";

const CHANNEL = "C0SALES0001";
// Short confirmation window so delayed lookups settle inside a twin proof without clock control.
const CONFIRM_WINDOW_MS = 0;

const lead = (caseId, over = {}) => ({
  leadId: `L-${caseId}`,
  name: "Alex Buyer",
  email: `lead-${caseId.replaceAll("_", "-")}@example.test`,
  salesChannel: CHANNEL,
  calendarId: "primary",
  confirmWindowMs: CONFIRM_WINDOW_MS,
  ...over,
});

function faulted(id, name, provider, scenario, assertions, evidence = "refusal") {
  return check(id, name, [start(id, lead(id))], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence } });
}

export const checks = [
  check(
    "baseline",
    "Form submit upserts the contact, creates one Deal, sends follow-up email, confirms, books Calendar and notifies Slack",
    [start("baseline", lead("baseline"))],
    all(
      runs([eq("phase", "DONE"), eq("outcome", "ok")]),
      runs([action("hubspot.upsert_contact", "applied")]),
      runs([action("hubspot.create_deal", "applied", 1, [eq("attempts", 1)])]),
      runs([action("gmail.send_followup", "applied", 1, [eq("attempts", 1)])]),
      runs([action("calendar.create_followup", "applied")]),
      runs([action("slack.notify_complete", "applied")]),
      runs([action("slack.handoff_blocked", "skipped")]),
    ),
  ),
  check(
    "duplicate_start",
    "A re-delivered form submit does not create a second Deal or send a second email",
    [start("duplicate_start", lead("duplicate_start")), startAgain("duplicate_start", lead("duplicate_start"))],
    all(runs([action("hubspot.create_deal", "applied", 1, [eq("attempts", 1)])]), runs([action("gmail.send_followup", "applied", 1, [eq("attempts", 1)])])),
  ),
  check(
    "concurrent_start",
    "Four simultaneous deliveries of the same lead create one Deal and one email",
    [start("concurrent_start", lead("concurrent_start")), startAgain("concurrent_start", lead("concurrent_start"), 1, 4)],
    all(runs([action("hubspot.create_deal", "applied", 1, [eq("attempts", 1)])]), runs([action("gmail.send_followup", "applied", 1, [eq("attempts", 1)])])),
  ),
  check(
    "refired_lead_adopts_deal",
    "A second run for the same leadId adopts the existing Deal and existing Message-ID instead of duplicating",
    [start("refired_lead_adopts_deal", lead("refired"), { runId: "refired-a-{{run_id}}" }), start("refired_lead_adopts_deal", lead("refired"), { runId: "refired-b-{{run_id}}" })],
    all(runs([], 2), runs([action("hubspot.create_deal", "applied")]), runs([action("hubspot.create_deal", "applied")])),
  ),
  check("invalid_input_rejected", "A missing email is rejected before any agent runs", [start("invalid_input_rejected", lead("invalid", { email: "not-an-email" }), { expectStatus: 400 })], runs([], 0)),
  check(
    "reconcile_contact_and_deal",
    "Reconcile confirms the HubSpot contact email and Deal name still match",
    [start("reconcile_contact_and_deal", lead("reconcile_contact_and_deal")), command("reconcile", 1)],
    all(runs([action("hubspot.upsert_contact", "applied", 1, [eq("reconciled", "match")])]), runs([action("hubspot.create_deal", "applied", 1, [eq("reconciled", "match")])])),
  ),
  faulted("hubspot_auth_failure", "HubSpot auth failure: no contact or Deal; Slack reports the blocked step", "hubspot", "auth_failure", [agent("crm-check", "failed"), noAction("hubspot.upsert_contact"), noAction("hubspot.create_deal"), action("slack.notify_blocked_step", "applied")]),
  faulted("gmail_auth_failure", "Gmail auth failure: Deal exists, email is not sent, calendar is withheld", "gmail", "auth_failure", [action("hubspot.create_deal", "applied"), action("gmail.send_followup", "failed"), noAction("calendar.create_followup")]),
  faulted("gmail_direct_send_rejected", "A refused Gmail send does not create a calendar event", "gmail", "direct_send_rejected", [action("gmail.send_followup", "failed"), action("calendar.create_followup", "skipped")]),
  faulted(
    "gmail_lost_send_response",
    "Accepted send with a lost HTTP response is recovered by Message-ID lookup; still one email and one calendar event",
    "gmail",
    "direct_send_accepted_response_loss",
    [action("gmail.send_followup", "applied", 1, [eq("attempts", 1)]), action("calendar.create_followup", "applied")],
    "accepted_response_retry",
  ),
  faulted("calendar_rate_limited", "Calendar rate limiting withholds the event after a confirmed email; Slack handoff explains the block", "google-calendar", "rate_limited", [action("gmail.send_followup", "applied"), action("calendar.create_followup", "failed"), action("slack.handoff_blocked", "applied")]),
  faulted("slack_not_in_channel", "Slack not_in_channel fails the completion post only after the calendar event exists", "slack", "not_in_channel", [action("calendar.create_followup", "applied"), action("slack.notify_complete", "failed"), eq("outcome", "partial")]),
  check("restart_while_waiting", "A run waiting on confirmation timers survives a real runtime restart and completes", [start("restart_while_waiting", lead("restart_while_waiting")), restart], runs([eq("phase", "DONE"), action("calendar.create_followup", "applied")])),
  blocked(
    "live_inbox_delivery",
    "Prove the follow-up reached a real recipient inbox (not only the twin Sent label)",
    "engine_unsupported",
    "FetchSandbox Gmail twin confirms send and Sent-label read-back; it does not attest SMTP delivery to an external mailbox.",
    ["acme-ops/src/workflows/lead-follow-up.ts gmail.send_followup", "list_workflows(spec_slug=gmail) send_draft_acknowledgement: 'no inbox delivery claim'"],
  ),
  blocked(
    "gmail_lookup_unavailable_no_resend",
    "When send is accepted but Message-ID lookup is unavailable, the runtime must not resend or create the calendar event",
    "observation_missing",
    "Arming gmail:direct_send_accepted_lookup_unavailable and asserting zero additional sends requires a twin send-count observer that this contract does not yet bind; covered by local fake-world tests.",
    ["acme-ops/test/lead-follow-up.test.ts unknown send without lookup", "validate_integration probe gmail:direct_send_accepted_lookup_unavailable"],
  ),
];

export default {
  workflow: "lead-follow-up",
  providers: ["hubspot", "gmail", "google-calendar", "slack"],
  appEnv: { PROVIDER_TIMEOUT_MS: "3000", LEAD_FOLLOWUP_CONFIRM_WINDOW_MS: "0" },
  context: {
    goal: "Prove the lead-follow-up AgentCore runtime: form lead → HubSpot contact+Deal (idempotent by leadId) → Gmail follow-up (Message-ID keyed, timeout reconciles) → up to three confirmation lookups → Calendar only after confirmed email → Slack completion or blocked handoff.",
    workflow: "POST /invocations {action:start} runs CRM, send, confirmation timers and gated calendar/Slack; {action:tick} advances delayed confirms; {action:reconcile} re-reads HubSpot/Gmail/Calendar. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: "No cross-tenant writes; leads are scoped by leadId and email on the twin.",
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: "No money movement.",
    duplicate_replay: ["duplicate_start", "refired_lead_adopts_deal"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: ["refired_lead_adopts_deal"],
    delayed_or_missing_events: ["restart_while_waiting"],
    provider_auth_and_scopes: ["hubspot_auth_failure", "gmail_auth_failure"],
    rate_limit_server_error_timeout: ["calendar_rate_limited", "gmail_direct_send_rejected"],
    accepted_effect_response_loss: ["gmail_lost_send_response"],
    partial_effects_and_recovery: ["slack_not_in_channel", "gmail_auth_failure"],
    restart_and_durability: ["restart_while_waiting"],
    reconciliation: ["reconcile_contact_and_deal"],
    cancellation_refund_entitlements: "No cancellations or refunds.",
    data_and_privacy_boundaries: ["live_inbox_delivery"],
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: ["acme-ops/src/workflows/lead-follow-up.ts", "acme-ops/src/providers/{hubspot,google,slack}.ts", "acme-ops/src/kit/engine.ts"],
};
