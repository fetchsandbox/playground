import { action, blocked, check, command, eq, restart, runs, start } from "./lib.mjs";

// Lead follow-up contract. Every check submits its own synthetic lead
// (L-<check>, lead-<check>@example.test) to the real runtime, observes the
// run record the runtime saved, and independently asserts the session's
// HubSpot, Gmail, Calendar and Slack twins.
//
// Timing is compressed for the run and recorded here (appEnv): the 3 email
// confirmation lookups are 15 s apart instead of 10 minutes, re-checks after
// a refused/unknown write wait 3 s instead of 2 minutes, and the client
// timeout is 4 s so a held (accepted) response really ends in a disconnect.
// The production spacing (+10/+20/+30 min) is covered by the local clock test.

const CHANNEL = "C0SALES0001";
const OWNER = "U0SALESLEAD";

const slug = (c) => c.replaceAll("_", "-");
const leadId = (c) => `L-${slug(c)}`;
const email = (c) => `lead-${slug(c)}@example.test`;
// The Slack channel and the handoff person come from runtime config (appEnv), as a form adapter would supply them.
const lead = (c, over = {}) => ({ leadId: leadId(c), name: "Ada Lovelace", email: email(c), ...over });
const submit = (c, over = {}, opts = {}) => start(c, lead(c, over), opts);

// --- Independent provider (twin) state for one lead ------------------------
const contains = (select, text) => ({ select, contains: text, required: true });
const contacts = (c, n) => ({ provider: "hubspot", collection: "contacts", assertion: { select: "records[*]", count: n, required: true, where: [eq("properties.email", email(c))] } });
const deals = (c, n) => ({ provider: "hubspot", collection: "deals", assertion: { select: "records[*]", count: n, required: true, where: [contains("properties.dealname", `Lead ${leadId(c)} `)] } });
const sent = (c, n) => ({
  provider: "gmail",
  collection: "messages",
  // The lead's address appears only in the To header of messages sent to that lead.
  assertion: { select: "records[*]", count: n, required: true, where: [{ select: "payload.headers[*]", count: 1, required: true, where: [eq("value", email(c))] }] },
});
const events = (c, n) => ({ provider: "google-calendar", collection: "events", assertion: { select: "records[*]", count: n, required: true, where: [contains("summary", `(lead ${leadId(c)})`)] } });
const posted = (c, n, ...text) => ({ provider: "slack", collection: "messages", assertion: { select: "records[*]", count: n, required: true, where: [contains("text", `[lead-followup ${leadId(c)}]`), ...text.map((t) => contains("text", t))] } });
const twin = (c, ...provider_assertions) => ({ ...c, provider_assertions });

// --- Saved run state ---------------------------------------------------------
const done = (outcome) => [eq("phase", "DONE"), eq("outcome", outcome)];
const STEPS = ["hubspot.contact", "hubspot.deal", "gmail.send_followup", "calendar.followup_event"];
const allApplied = STEPS.map((id) => action(id, "applied"));
const complete = action("slack.notify_team", "applied", 1, [eq("detail.kind", "complete")]);
const handoff = (step) => action("slack.notify_team", "applied", 1, [eq("detail.kind", "blocked"), eq("detail.blockedStep", step)]);
const skipped = (...ids) => ids.map((id) => action(id, "skipped"));

/** For runs that finish through durable re-checks: poll the saved state (no repeat) up to `seconds`. */
function eventually(c, seconds) {
  const leaf = c.assertion.all_of ? c.assertion.all_of[0] : c.assertion;
  Object.assign(leaf, { repeat: 1, stable_under_repeat: false });
  c.observation_deadline_seconds = seconds;
  return c;
}

function faulted(id, name, provider, scenario, conds, { evidence = "refusal", over = {}, extra = [] } = {}) {
  return check(id, name, [submit(id, over), ...extra], runs(conds), { fault: { provider, scenario, evidence } });
}

export const checks = [
  // ---- Happy path, identity of effects, replay, concurrency, input ---------------------------
  twin(
    check("baseline", "New lead: one contact, one verified deal, one confirmed email, then one event, then one Slack completion", [submit("baseline")], runs([
      ...done("ok"),
      action("hubspot.contact", "applied", 1, [eq("detail.verified", true)]),
      action("hubspot.deal", "applied", 1, [eq("detail.verified", true), eq("detail.associated", true)]),
      action("gmail.send_followup", "applied", 1, [eq("detail.state", "confirmed")]),
      action("calendar.followup_event", "applied"),
      complete,
    ])),
    contacts("baseline", 1), deals("baseline", 1), sent("baseline", 1), events("baseline", 1), posted("baseline", 1, ":white_check_mark: Lead followed up"),
  ),
  twin(
    check("existing_contact_adopted", "Existing HubSpot contact is adopted, not duplicated or overwritten", [submit("existing_contact_adopted")], runs([...done("ok"), action("hubspot.contact", "applied", 1, [eq("detail.created", false)])])),
    contacts("existing_contact_adopted", 1), deals("existing_contact_adopted", 1),
    { provider: "hubspot", collection: "contacts", assertion: { select: "records[*]", count: 1, required: true, where: [eq("properties.email", email("existing_contact_adopted")), eq("properties.firstname", "Augusta")] } },
  ),
  twin(
    check("resubmitted_lead_joins_run", "Resubmitted lead (new submission id) joins the run; nothing written twice", [submit("resubmitted_lead_joins_run"), submit("resubmitted_lead_joins_run", { name: "Ada K. Lovelace" }, { runId: "resubmit-b-{{run_id}}" })], runs([...done("ok"), eq("duplicateStarts", 1), ...allApplied, complete])),
    contacts("resubmitted_lead_joins_run", 1), deals("resubmitted_lead_joins_run", 1), sent("resubmitted_lead_joins_run", 1), events("resubmitted_lead_joins_run", 1), posted("resubmitted_lead_joins_run", 1),
  ),
  twin(
    check("concurrent_first_submissions", "5 concurrent first submissions: one run, one of each effect", [submit("concurrent_first_submissions", {}, { concurrency: 5 })], runs([...done("ok"), eq("duplicateStarts", 4), ...allApplied, complete])),
    contacts("concurrent_first_submissions", 1), deals("concurrent_first_submissions", 1), sent("concurrent_first_submissions", 1), events("concurrent_first_submissions", 1), posted("concurrent_first_submissions", 1),
  ),
  twin(
    check("invalid_input_rejected", "Malformed submissions (bad email, unsafe lead ID, empty or blank name) are rejected before any write", [
      submit("invalid_input_rejected", { email: "not-an-email" }, { expectStatus: 400 }),
      submit("invalid_input_rejected", { leadId: "L 1/../x" }, { expectStatus: 400 }),
      submit("invalid_input_rejected", { name: "" }, { expectStatus: 400 }),
      submit("invalid_input_rejected", { name: "   " }, { expectStatus: 400 }),
    ], runs([], 0)),
    contacts("invalid_input_rejected", 0), sent("invalid_input_rejected", 0),
  ),
  check("reconcile_reads_back", "Reconcile reads every effect back from its provider: all match", [submit("reconcile_reads_back"), command("reconcile", 1)], runs([
    ...done("ok"),
    ...[...STEPS, "slack.notify_team"].map((id) => action(id, "applied", 1, [eq("reconciled", "match")])),
  ])),

  // ---- Unknown outcomes: accepted writes whose response is lost ---------------------------
  twin(
    faulted("hubspot_deal_response_loss", "Deal accepted, response lost: read back by lead token and id, no second deal", "hubspot", "deal_accepted_response_loss",
      [...done("ok"), action("hubspot.deal", "applied", 1, [eq("detail.via", "readback"), eq("detail.verified", true)]), complete], { evidence: "accepted_response_readback" }),
    deals("hubspot_deal_response_loss", 1), sent("hubspot_deal_response_loss", 1),
  ),
  twin(
    eventually(faulted("gmail_send_response_loss", "Email accepted, response lost: no resend; confirmed by lookup 1, then booked", "gmail", "direct_send_accepted_response_loss",
      [...done("ok"), action("gmail.send_followup", "applied", 1, [eq("detail.confirmedBy", "confirmation lookup 1/3"), eq("detail.sendAttempts", 1)]), action("calendar.followup_event", "applied"), complete], { evidence: "accepted_response_readback" }), 120),
    sent("gmail_send_response_loss", 1), events("gmail_send_response_loss", 1), posted("gmail_send_response_loss", 1),
  ),
  twin(
    eventually(faulted("gmail_unresolved_handoff", "Email outcome unresolvable: 3 lookups, no resend, no event, Slack handoff to a person", "gmail", "direct_send_accepted_lookup_unavailable",
      [...done("partial"), action("gmail.send_followup", "failed", 1, [eq("errorCode", "gmail:delivery_unconfirmed")]), ...skipped("calendar.followup_event"), handoff("gmail.send_followup")]), 150),
    sent("gmail_unresolved_handoff", 1), events("gmail_unresolved_handoff", 0),
    posted("gmail_unresolved_handoff", 1, `<@${OWNER}>`, "blocked at *follow-up email (Gmail)*", email("gmail_unresolved_handoff"), "after 3 lookups", "MAY have been sent", "rfc822msgid:"),
  ),

  // ---- Refusals: nothing accepted, bounded re-checks, then a person ---------------------------
  twin(
    eventually(faulted("gmail_send_rejected", "Send always refused: at most 3 tries, nothing sent or booked, handoff", "gmail", "direct_send_rejected",
      [...done("partial"), action("gmail.send_followup", "failed"), ...skipped("calendar.followup_event"), handoff("gmail.send_followup")]), 90),
    sent("gmail_send_rejected", 0), events("gmail_send_rejected", 0), posted("gmail_send_rejected", 1, "nothing was sent to the lead"),
  ),
  twin(
    eventually(faulted("gmail_send_rejected_once", "Send refused once: re-checked, sent once, then booked", "gmail", "direct_send_rejected_once",
      [...done("ok"), action("gmail.send_followup", "applied", 1, [eq("detail.sendAttempts", 2)]), action("calendar.followup_event", "applied"), complete]), 90),
    sent("gmail_send_rejected_once", 1), events("gmail_send_rejected_once", 1),
  ),
  twin(
    faulted("gmail_auth_failure", "Gmail auth failure: blocked at email, nothing sent or booked, handoff", "gmail", "auth_failure",
      [...done("partial"), action("gmail.send_followup", "failed"), ...skipped("calendar.followup_event"), handoff("gmail.send_followup")]),
    deals("gmail_auth_failure", 1), sent("gmail_auth_failure", 0), events("gmail_auth_failure", 0), posted("gmail_auth_failure", 1),
  ),
  twin(
    eventually(faulted("gmail_rate_limited", "Gmail rate limited: bounded re-checks, nothing sent, handoff", "gmail", "rate_limited",
      [...done("partial"), action("gmail.send_followup", "failed"), ...skipped("calendar.followup_event"), handoff("gmail.send_followup")]), 120),
    sent("gmail_rate_limited", 0), events("gmail_rate_limited", 0),
  ),
  twin(
    faulted("hubspot_auth_failure", "HubSpot auth failure: blocked at contact, nothing downstream, handoff", "hubspot", "auth_failure",
      [...done("partial"), action("hubspot.contact", "failed"), ...skipped("hubspot.deal", "gmail.send_followup", "calendar.followup_event"), handoff("hubspot.contact")]),
    deals("hubspot_auth_failure", 0), sent("hubspot_auth_failure", 0), events("hubspot_auth_failure", 0), posted("hubspot_auth_failure", 1, "Nothing was emailed to the lead"),
  ),
  twin(
    eventually(faulted("hubspot_scope_denied", "HubSpot writes forbidden: bounded re-checks, handoff, nothing downstream", "hubspot", "scope_denied",
      [...done("partial"), action("hubspot.contact", "failed"), ...skipped("hubspot.deal", "gmail.send_followup", "calendar.followup_event"), handoff("hubspot.contact")]), 90),
    contacts("hubspot_scope_denied", 0), deals("hubspot_scope_denied", 0), sent("hubspot_scope_denied", 0),
  ),
  twin(
    eventually(faulted("hubspot_token_expired", "HubSpot token dies mid-run: stops at the failing step, handoff, no email", "hubspot", "token_expired",
      [...done("partial"), action("slack.notify_team", "applied", 1, [eq("detail.kind", "blocked")]), ...skipped("gmail.send_followup", "calendar.followup_event")]), 90),
    deals("hubspot_token_expired", 0), sent("hubspot_token_expired", 0), events("hubspot_token_expired", 0),
  ),
  twin(
    eventually(faulted("hubspot_rate_limited", "HubSpot rate limited: bounded re-checks, no writes, no email, handoff", "hubspot", "rate_limited",
      [...done("partial"), action("hubspot.contact", "failed"), ...skipped("hubspot.deal", "gmail.send_followup", "calendar.followup_event"), handoff("hubspot.contact")]), 120),
    contacts("hubspot_rate_limited", 0), deals("hubspot_rate_limited", 0), sent("hubspot_rate_limited", 0),
  ),
  twin(
    faulted("calendar_auth_failure", "Calendar auth failure: email stays single, handoff for the event only", "google-calendar", "auth_failure",
      [...done("partial"), action("gmail.send_followup", "applied"), action("calendar.followup_event", "failed"), handoff("calendar.followup_event")]),
    sent("calendar_auth_failure", 1), events("calendar_auth_failure", 0), posted("calendar_auth_failure", 1, "Only the calendar event is missing"),
  ),
  twin(
    eventually(faulted("calendar_rate_limited", "Calendar rate limited: bounded re-checks, no second email, handoff", "google-calendar", "rate_limited",
      [...done("partial"), action("gmail.send_followup", "applied"), action("calendar.followup_event", "failed"), handoff("calendar.followup_event")]), 120),
    sent("calendar_rate_limited", 1), events("calendar_rate_limited", 0),
  ),

  // ---- Slack: the notification itself fails ---------------------------------------------------
  twin(
    faulted("slack_channel_not_found", "Slack channel_not_found: notification recorded failed, never as sent", "slack", "channel_not_found",
      [...done("partial"), ...allApplied, action("slack.notify_team", "failed", 1, [eq("errorCode", "slack:channel_not_found")])]),
    posted("slack_channel_not_found", 0), sent("slack_channel_not_found", 1),
  ),
  twin(
    faulted("slack_not_in_channel", "Slack not_in_channel: notification recorded failed", "slack", "not_in_channel",
      [...done("partial"), ...allApplied, action("slack.notify_team", "failed", 1, [eq("errorCode", "slack:not_in_channel")])]),
    posted("slack_not_in_channel", 0),
  ),
  twin(
    faulted("slack_missing_scope", "Slack missing_scope: notification recorded failed", "slack", "missing_scope",
      [...done("partial"), ...allApplied, action("slack.notify_team", "failed", 1, [eq("errorCode", "slack:missing_scope")])]),
    posted("slack_missing_scope", 0),
  ),
  twin(
    eventually(faulted("slack_rate_limited", "Slack rate limited: bounded re-checks, recorded failed, effects single", "slack", "rate_limited",
      [...done("partial"), ...allApplied, action("slack.notify_team", "failed")]), 120),
    posted("slack_rate_limited", 0), sent("slack_rate_limited", 1), events("slack_rate_limited", 1),
  ),

  // ---- Durability ------------------------------------------------------------------------------
  twin(
    eventually(check("restart_during_confirmation", "Restart while an unconfirmed email awaits lookups: no resend; confirmed after recovery, then booked", [
      submit("restart_during_confirmation"),
      restart,
      { provider_control: { provider: "gmail", scenario: "default" } },
    ], runs([...done("ok"), action("gmail.send_followup", "applied", 1, [eq("detail.state", "confirmed"), eq("detail.sendAttempts", 1)]), action("calendar.followup_event", "applied"), complete]), { fault: { provider: "gmail", scenario: "direct_send_accepted_lookup_unavailable", evidence: "refusal" } }), 150),
    sent("restart_during_confirmation", 1), events("restart_during_confirmation", 1),
  ),

  // ---- Declared but not measurable on this backend --------------------------------------------
  blocked("slack_slow_network_single_post", "A Slack post whose response arrives after the client timeout is reconciled through conversations.history and never posted twice", "observation_missing",
    "slack:slow_network only delays every response by 3 s; it records no refusal and no archived accepted write, so neither refusal nor accepted_response_readback evidence can be produced, and Slack has no direct GET of a message by ts for a read-back. The reconcile path (lost post found by its marker, no second post) is covered by the local fake-world test only.",
    ["fetchsandbox list_scenarios slack: slow_network = 'Every response delayed 3000ms'", "validate_integration capabilities.http_contract_limits.fault_evidence: refusal, accepted_response_loss, accepted_response_retry, accepted_response_readback, webhook_withheld", "acme-ops/test/lead-follow-up.test.ts 'Slack post accepted but response lost'"]),
  blocked("email_confirmation_spacing_30_minutes", "The three confirmation lookups are spaced 10 minutes apart (+10/+20/+30 min) before the handoff", "setup_missing",
    "This run compresses the interval to 15 s (LEAD_EMAIL_CONFIRM_INTERVAL_MS) so the suite fits the default 900 s execution budget; the twin run measures the count, order and outcome of the lookups, not the 30-minute wall-clock spacing. The production spacing is asserted with an injected clock in the local test only.",
    ["acme-ops/verify/contracts/lead-follow-up.mjs appEnv", "acme-ops/test/lead-follow-up.test.ts 'unresolved email: 3 lookups at +10/+20/+30 min'"]),
];

/** The existing HubSpot contact for existing_contact_adopted, prepared and read back through FetchSandbox fixtures. */
async function seed(_legs, log, { mcp, sessionId }) {
  const wait = async (res) => {
    for (let i = 0; i < 60 && res?.status === "running" && res.job_id; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      res = await mcp.call("get_job", { job_id: res.job_id });
    }
    return res;
  };
  const addr = email("existing_contact_adopted");
  const res = await wait(await mcp.call("validate_integration", {
    session_id: sessionId,
    fixtures: {
      id: "lead-follow-up-existing-contact",
      steps: [
        { spec: "hubspot", method: "POST", path: "/crm/v3/objects/contacts", body: { properties: { email: addr, firstname: "Augusta" } }, expect_status: 201 },
        { spec: "hubspot", method: "GET", path: "/crm/v3/objects/contacts/{{step1.id}}", assertion: { select: "properties.email", equals: addr, required: true, count: 1 } },
      ],
    },
  }));
  const ok = JSON.stringify(res ?? {}).match(/"(status|fixture_status|readiness)"\s*:\s*"(ready|passed|completed|done|verified)"/);
  log("fixture existing contact", ok ? ok[2] : JSON.stringify(res ?? {}).slice(0, 400));
  if (!ok) throw new Error(`fixture not ready: ${JSON.stringify(res ?? {}).slice(0, 800)}`);
  return { existing_contact: addr, fixture: res?.fixture_id ?? res?.id ?? null };
}

export default {
  workflow: "lead-follow-up",
  providers: ["hubspot", "gmail", "google-calendar", "slack"],
  seed,
  appEnv: {
    PROVIDER_TIMEOUT_MS: "4000",
    LEAD_EMAIL_CONFIRM_INTERVAL_MS: "15000",
    LEAD_FOLLOWUP_SLACK_CHANNEL: CHANNEL,
    LEAD_FOLLOWUP_OWNER_SLACK_ID: OWNER,
    LEAD_RETRY_INTERVAL_MS: "3000",
    TICK_INTERVAL_MS: "1000",
  },
  context: {
    goal: "Prove the lead-follow-up AgentCore runtime: a lead form submission (leadId, name, email) → HubSpot contact found or created, one sales deal, one Gmail follow-up email, a Calendar follow-up only after the email is confirmed, and a Slack completion or blocked-step handoff. No duplicate deals, emails or posts; repeated submissions safe; a timeout means an unknown outcome that is reconciled before any repeat; an unconfirmed email gets 3 confirmation lookups, then a person.",
    workflow: "POST /invocations {action:start,input:{leadId,name,email,salesChannel,handoffUserId}}; the run id is lead-<leadId> so every submission of a lead joins one run. Steps reconcile first (contact by email, deal by lead token + GET, email by RFC Message-ID + GET, event by derived id, Slack by marker in history); an unknown or refused write becomes a durable scheduled re-check woken by the runtime's tick. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected; durable file store across restarts.",
  },
  checks,
  scope_review: checks.map((c) => ({ check_id: c.id, classification: "in_scope", reason: "Promised by the lead follow-up request (no duplicates, safe resubmission, reconcile unknown outcomes, 3 lookups then a person).", evidence: ["acme-ops/src/workflows/lead-follow-up.ts"] })),
  coverage: {
    baseline: ["baseline"],
    identity_and_access: "No requester identity or tenant: the trigger is an internal lead form and every lead is processed for the one sales team; POST /invocations is reached only through the AgentCore runtime (IAM) and the verifier read routes require the handoff bearer token. No webhook handler is exposed.",
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: "The deal is created without amount, currency or quantity; no money moves.",
    duplicate_replay: ["resubmitted_lead_joins_run", "hubspot_deal_response_loss", "gmail_send_response_loss", "existing_contact_adopted"],
    concurrency: ["concurrent_first_submissions"],
    ordering_and_stale_events: ["baseline", "gmail_send_response_loss", "gmail_unresolved_handoff"],
    delayed_or_missing_events: ["gmail_send_response_loss", "gmail_unresolved_handoff", "restart_during_confirmation", "email_confirmation_spacing_30_minutes"],
    provider_auth_and_scopes: ["hubspot_auth_failure", "hubspot_scope_denied", "hubspot_token_expired", "gmail_auth_failure", "calendar_auth_failure", "slack_missing_scope", "slack_not_in_channel", "slack_channel_not_found"],
    rate_limit_server_error_timeout: ["hubspot_rate_limited", "gmail_rate_limited", "calendar_rate_limited", "slack_rate_limited", "slack_slow_network_single_post"],
    accepted_effect_response_loss: ["hubspot_deal_response_loss", "gmail_send_response_loss", "gmail_unresolved_handoff"],
    partial_effects_and_recovery: ["gmail_send_rejected", "gmail_send_rejected_once", "calendar_auth_failure", "hubspot_token_expired", "slack_rate_limited"],
    restart_and_durability: ["restart_during_confirmation"],
    reconciliation: ["reconcile_reads_back", "hubspot_deal_response_loss", "gmail_send_response_loss"],
    cancellation_refund_entitlements: "The workflow promises no cancellation, refund or entitlement behavior.",
    data_and_privacy_boundaries: "Synthetic example.test leads only. The lead's name and email appear in the internal sales channel's handoff (requested); the follow-up email goes only to the submitted address; no calendar invitation is sent to the lead.",
    cleanup_and_isolation: ["baseline", "concurrent_first_submissions", "invalid_input_rejected"],
  },
  evidence: ["acme-ops/src/workflows/lead-follow-up.ts", "acme-ops/src/kit/engine.ts (runKey, RetryLater)", "acme-ops/src/kit/http.ts (idempotent:false)", "acme-ops/src/providers/{hubspot,google,slack}.ts", "acme-ops/test/lead-follow-up.test.ts"],
};
