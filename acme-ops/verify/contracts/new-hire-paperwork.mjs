import { action, agent, all, blocked, check, eq, noAction, proofNow, restart, runs, start, startAgain } from "./lib.mjs";

// Executable expectations for new-hire-paperwork (DocuSign templates → Box or
// Dropbox, Slack, Kit v2 signal and timers). FetchSandbox has no DocuSign or
// Dropbox twin ("Unknown providers: docusign, dropbox"), so the runtime runs
// with DocuSign unconfigured. Measured: the policy-only decision (no packet),
// failing closed when DocuSign can't be checked, dedupe, restart and input
// validation. Sending, completion, reminders and filing are blocked checks with
// the exact reason, and are covered locally in test/new-hire-paperwork.test.ts.
const DAY = 86_400_000;
const date = (days) => new Date(proofNow() + days * DAY).toISOString().slice(0, 10);
const hire = (c, over = {}) => ({ hireId: `H-${c.replaceAll("_", "-")}`.slice(0, 40), employee: { name: "Priya Rao", email: "priya.rao@example.com" }, country: "US", employmentType: "full_time", startDate: date(21), manager: { name: "Lee Park", email: "lee@acme.example" }, ...over });
const NO_DOCUSIGN = ["validate_integration providers:[docusign, dropbox] → 'Validation sessions require distinct known providers. Unknown providers: docusign, dropbox' (2026-10-29)", "list_specs filter docusign → 0 specs"];

export const checks = [
  check("baseline", "A finalized hire starts one recorded run (provider-independent, so every later check is measured)", [start("baseline", hire("baseline"))], runs([], 1)),
  check("docusign_unavailable_sends_nothing", "When DocuSign can't be checked for an existing envelope, nothing is sent and People Ops is told", [start("docusign_unavailable_sends_nothing", hire("docusign_unavailable"))], all(runs([eq("output.mode", "blocked"), agent("envelopes", "skipped")]), runs([action("slack.post_blocked", "applied")]), runs([noAction("docusign.send_packet")]))),
  check("no_packet_sends_nothing", "A hire no policy packet matches (a country without one) gets nothing sent, decided from policy alone", [start("no_packet_sends_nothing", hire("no_packet", { country: "DE" }))], all(runs([eq("output.mode", "no_packet")]), runs([action("slack.post_no_packet", "applied")]), runs([noAction("docusign.send_packet")]))),
  check("duplicate_hire_event", "A re-delivered hire event finds the same run and posts once", [start("duplicate_hire_event", hire("duplicate")), startAgain("duplicate_hire_event", hire("duplicate"))], runs([action("slack.post_blocked", "applied", 1, [eq("attempts", 1)])])),
  check("concurrent_hire_events", "Four simultaneous deliveries of the same hire post once", [start("concurrent_hire_events", hire("concurrent")), startAgain("concurrent_hire_events", hire("concurrent"), 1, 4)], runs([action("slack.post_blocked", "applied", 1, [eq("attempts", 1)])])),
  check("invalid_input_rejected", "A hire with a non-ISO country or an invalid email is rejected before any agent runs", [start("invalid_input_rejected", hire("invalid", { country: "usa", employee: { name: "X", email: "not-an-email" } }), { expectStatus: 400 })], runs([], 0)),
  check("slack_rate_limited", "Slack rate limiting fails the People Ops notice visibly", [start("slack_rate_limited", hire("slack_rl"))], runs([action("slack.post_blocked", "failed")]), { fault: { provider: "slack", scenario: "rate_limited", evidence: "refusal" } }),
  check("restart_then_redelivery", "After a runtime restart, a re-delivered hire event finds the saved run and repeats nothing", [start("restart_then_redelivery", hire("restart")), restart, startAgain("restart_then_redelivery", hire("restart"))], all(runs([eq("phase", "DONE")]), runs([action("slack.post_blocked", "applied", 1, [eq("attempts", 1)])]))),
  blocked("packet_sent_from_templates", "A US full-time hire gets one envelope of the policy's three templates, countersigned by People, with DocuSign reminders and expiry", "setup_missing", "No DocuSign twin: composite-template envelopes can't be created or read back.", NO_DOCUSIGN),
  blocked("existing_envelope_reused", "A second run for the same hire reuses the envelope found by its external id; nothing is re-sent", "setup_missing", "Needs DocuSign envelope listing by custom_field.", NO_DOCUSIGN),
  blocked("completion_rechecked_and_filed", "A Connect completion signal is re-checked with DocuSign, then the signed packet and certificate are filed in the employee's folder", "setup_missing", "Needs a DocuSign envelope that a contract can move to completed, documents/combined bytes, and a store twin that keeps uploads (Box: R29, Dropbox: missing).", [...NO_DOCUSIGN, "Box twin: uploaded file → 404 on GET (see signed-agreement-filing box_store_follows_box_api)"]),
  blocked("forged_completion_refused", "A completion signal while DocuSign says sent files nothing and the run escalates", "setup_missing", "Needs the DocuSign twin to report a sent envelope.", NO_DOCUSIGN),
  blocked("unsigned_reminders_before_start", "People Ops is told 7 and 2 days before the start date while the packet is unsigned", "setup_missing", "Needs the DocuSign twin, and the runtime clock to reach the reminder dates during an attempt (fixture time steps are unavailable during an active attempt).", [...NO_DOCUSIGN, "validate_integration fixtures: /__fetchsandbox/fixtures/time is unavailable during active attempts"]),
  blocked("declined_or_unsigned_escalated", "A declined/voided envelope, or no signature by the start date, is escalated naming the manager", "setup_missing", "Needs the DocuSign twin (declined status) and the start-date deadline inside an attempt.", NO_DOCUSIGN),
  blocked("too_close_start_sends_nothing", "A start date inside the minimum lead time sends nothing automatically", "setup_missing", "Decided after the existing-envelope check, which needs DocuSign.", NO_DOCUSIGN),
];

export default {
  workflow: "new-hire-paperwork",
  providers: ["slack"],
  context: {
    goal: "Prove the new-hire-paperwork AgentCore runtime: a finalized hire → policy packet by country and employment type → one DocuSign envelope from composite templates (reminders, expiry, People countersigner) → Connect completion signal re-checked with DocuSign → signed packet filed in Box or Dropbox; People Ops reminded before the start date and escalated on decline, void or no signature; nothing sent when no packet matches, the start is too close, or DocuSign can't be checked.",
    workflow: "POST /invocations {action:start, input:{hireId, employee, country, employmentType, startDate, manager}}; {action:signal} from the Connect adapter; {action:tick} for reminders. Policy: policies/new-hire-paperwork.json.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["forged_completion_refused"],
    schema_and_value_boundaries: ["invalid_input_rejected", "no_packet_sends_nothing"],
    amount_currency_quantity: "No amounts are involved.",
    duplicate_replay: ["duplicate_hire_event", "existing_envelope_reused", "restart_then_redelivery"],
    concurrency: ["concurrent_hire_events"],
    ordering_and_stale_events: ["forged_completion_refused"],
    delayed_or_missing_events: ["declined_or_unsigned_escalated", "unsigned_reminders_before_start"],
    provider_auth_and_scopes: ["docusign_unavailable_sends_nothing"],
    rate_limit_server_error_timeout: ["slack_rate_limited"],
    accepted_effect_response_loss: "The send re-checks DocuSign by external id right before creating, so a lost create response is found on resume; covered locally.",
    partial_effects_and_recovery: ["completion_rechecked_and_filed"],
    restart_and_durability: ["restart_then_redelivery"],
    reconciliation: ["completion_rechecked_and_filed"],
    cancellation_refund_entitlements: ["declined_or_unsigned_escalated"],
    data_and_privacy_boundaries: ["packet_sent_from_templates", "too_close_start_sends_nothing"],
    cleanup_and_isolation: ["baseline", "concurrent_hire_events"],
  },
  evidence: ["acme-ops/src/workflows/new-hire-paperwork.ts", "acme-ops/policies/new-hire-paperwork.json", "acme-ops/src/providers/storage.ts", "acme-ops/src/providers/work.ts DocuSignClient", "acme-ops/src/kit/engine.ts"],
};
