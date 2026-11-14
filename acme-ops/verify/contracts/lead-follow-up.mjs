import { action, blocked, check, command, eq, restart, runs, runsPath, start } from "./lib.mjs";

// Lead follow-up contract (revision 2). Every check submits its own synthetic
// lead (L-<check>, lead-<check>@example.test) to the real runtime, observes
// the run record it saved, and independently asserts the session's HubSpot,
// Gmail, Calendar and Slack twins.
//
// Timing (appEnv below). The email confirmation interval is compressed to
// 20 s here because the managed relay lease (1800 s) cannot hold the real
// 30-minute schedule; the real schedule is measured through the
// caller-executed path (email_confirmation_spacing_30_minutes). Other
// settings are test settings, recorded here: re-check after a refused or
// unknown HubSpot/Calendar/Slack write 15 s (production 2 min), client
// timeouts 4 s (Slack 2 s) so held responses end in a real disconnect,
// stale-worker recovery after 20 s (production 1 min / claim 5 min).

const CHANNEL = "C0SALES0001";
const OWNER = "U0SALESLEAD";

const slug = (c) => c.replaceAll("_", "-");
const leadId = (c) => `L-${slug(c)}`;
const email = (c) => `lead-${slug(c)}@example.test`;
// The Slack channel and the handoff person come from runtime config (appEnv), as a form adapter would supply them.
const lead = (c, over = {}) => ({ leadId: leadId(c), name: "Ada Lovelace", email: email(c), ...over });
const submit = (c, over = {}, opts = {}) => start(c, lead(c, over), opts);
/** Start without waiting for the run to park (the verifier's next action runs while the workflow is mid-flight). */
const submitNoWait = (c, over = {}) => {
  const a = submit(c, over);
  return { ...a, body: { ...a.body, wait: false } };
};

// --- Independent provider (twin) state for one lead ------------------------
const contains = (select, text) => ({ select, contains: text, required: true });
const contacts = (addr, n) => ({ provider: "hubspot", collection: "contacts", assertion: { select: "records[*]", count: n, required: true, where: [eq("properties.email", addr)] } });
const deals = (id, n, ...name) => ({ provider: "hubspot", collection: "deals", assertion: { select: "records[*]", count: n, required: true, where: [contains("properties.dealname", `Lead ${id} `), ...name.map((t) => contains("properties.dealname", t))] } });
// The lead's address appears only in the To header of messages sent to that lead.
const sent = (addr, n) => ({ provider: "gmail", collection: "messages", assertion: { select: "records[*]", count: n, required: true, where: [{ select: "payload.headers[*]", count: 1, required: true, where: [eq("value", addr)] }] } });
const events = (id, n) => ({ provider: "google-calendar", collection: "events", assertion: { select: "records[*]", count: n, required: true, where: [contains("summary", `(lead ${id})`)] } });
const posted = (id, n, ...text) => ({ provider: "slack", collection: "messages", assertion: { select: "records[*]", count: n, required: true, where: [contains("text", `[lead-followup ${id}]`), ...text.map((t) => contains("text", t))] } });
const twin = (c, ...provider_assertions) => ({ ...c, provider_assertions });

// --- Saved run state ---------------------------------------------------------
const done = (outcome) => [eq("phase", "DONE"), eq("outcome", outcome)];
const STEPS = ["hubspot.contact", "hubspot.deal", "gmail.send_followup", "calendar.followup_event"];
const allApplied = STEPS.map((id) => action(id, "applied"));
const complete = action("slack.notify_team", "applied", 1, [eq("detail_kind", "complete")]);
const handoff = (step) => action("slack.notify_team", "applied", 1, [eq("detail_kind", "blocked"), eq("detail_blockedStep", step)]);
const skipped = (...ids) => ids.map((id) => action(id, "skipped"));
/** Exactly one run event whose message contains `text`. */
const event = (text) => ({ select: "events[*]", count: 1, required: true, where: [contains("msg", text)] });

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
  // ---- Happy path, effect identity, replay, concurrency, input ------------------------------
  // Probe: one new lead. Expect: 1 contact, 1 deal (read back, associated), 1 confirmed email, then 1 event, then 1 Slack completion.
  // Evidence: saved run (all applied, outcome ok) + each twin's records for this lead.
  twin(
    check("baseline", "New lead: one contact, one verified deal, one confirmed email, then one event, then one Slack completion", [submit("baseline")], runs([
      ...done("ok"),
      action("hubspot.contact", "applied", 1, [eq("detail_verified", true)]),
      action("hubspot.deal", "applied", 1, [eq("detail_verified", true), eq("detail_associated", true)]),
      action("gmail.send_followup", "applied", 1, [eq("detail_state", "confirmed")]),
      action("calendar.followup_event", "applied"),
      complete,
    ])),
    contacts(email("baseline"), 1), deals(leadId("baseline"), 1), sent(email("baseline"), 1), events(leadId("baseline"), 1), posted(leadId("baseline"), 1, ":white_check_mark: Lead followed up"),
  ),
  // Probe: the lead's email is already a HubSpot contact (fixture). Expect: adopted, not duplicated or overwritten.
  twin(
    check("existing_contact_adopted", "Existing HubSpot contact is adopted, not duplicated or overwritten", [submit("existing_contact_adopted")], runs([...done("ok"), action("hubspot.contact", "applied", 1, [eq("detail_created", false)])])),
    contacts(email("existing_contact_adopted"), 1), deals(leadId("existing_contact_adopted"), 1),
    { provider: "hubspot", collection: "contacts", assertion: { select: "records[*]", count: 1, required: true, where: [eq("properties.email", email("existing_contact_adopted")), eq("properties.firstname", "Augusta")] } },
  ),
  // Probe: the same lead submitted again with another submission id. Expect: one run, nothing written twice
  // (the verifier drives the check twice, so this is three submissions).
  twin(
    check("resubmitted_lead_joins_run", "Resubmitted lead (new submission id) joins the run; nothing written twice", [submit("resubmitted_lead_joins_run"), submit("resubmitted_lead_joins_run", { name: "Ada K. Lovelace" }, { runId: "resubmit-b-{{run_id}}" })], runs([...done("ok"), ...allApplied, complete])),
    contacts(email("resubmitted_lead_joins_run"), 1), deals(leadId("resubmitted_lead_joins_run"), 1), sent(email("resubmitted_lead_joins_run"), 1), events(leadId("resubmitted_lead_joins_run"), 1), posted(leadId("resubmitted_lead_joins_run"), 1),
  ),
  // Probe: 5 concurrent first submissions. Expect: one run, one of each effect.
  twin(
    check("concurrent_first_submissions", "5 concurrent first submissions: one run, one of each effect", [submit("concurrent_first_submissions", {}, { concurrency: 5 })], runs([...done("ok"), ...allApplied, complete])),
    contacts(email("concurrent_first_submissions"), 1), deals(leadId("concurrent_first_submissions"), 1), sent(email("concurrent_first_submissions"), 1), events(leadId("concurrent_first_submissions"), 1), posted(leadId("concurrent_first_submissions"), 1),
  ),
  // Probe: malformed submissions, and run-state reads with no / a wrong token. Expect: 400 / 401, no run, no writes, no data.
  twin(
    check("invalid_input_rejected", "Malformed submissions are rejected before any write; saved run state is not readable without the verifier token", [
      submit("invalid_input_rejected", { email: "not-an-email" }, { expectStatus: 400 }),
      submit("invalid_input_rejected", { leadId: "L 1/../x" }, { expectStatus: 400 }),
      submit("invalid_input_rejected", { name: "" }, { expectStatus: 400 }),
      submit("invalid_input_rejected", { name: "   " }, { expectStatus: 400 }),
      // Ownership of saved state (folded in from verifier_reads_require_token: the server allows 30 checks).
      { method: "GET", path: "/verify/runtime", authentication: "omitted", expect_status: 401 },
      { method: "GET", path: runsPath("baseline"), authentication: "omitted", expect_status: 401 },
      { method: "GET", path: runsPath("baseline"), authentication: "invalid", expect_status: 401 },
    ], runs([], 0)),
    contacts(email("invalid_input_rejected"), 0), sent(email("invalid_input_rejected"), 0),
  ),
  // Probe: reconcile after completion. Expect: every effect reads back as `match`.
  check("reconcile_reads_back", "Reconcile reads every effect back from its provider: all match", [submit("reconcile_reads_back"), command("reconcile", 1)], runs([
    ...done("ok"),
    ...[...STEPS, "slack.notify_team"].map((id) => action(id, "applied", 1, [eq("reconciled", "match")])),
  ])),

  // ---- Lost responses after acceptance ----------------------------------------------------------
  // Probe: HubSpot commits the deal and holds the response (~10 s); client times out at 4 s.
  // Expect: no repeat; the re-check (15 s later, after the hold) finds the deal by token + GET; one deal.
  // Evidence: accepted write + disconnect + later direct read (accepted_response_readback) + twin deal count.
  twin(
    eventually(faulted("hubspot_deal_response_loss", "Deal accepted, response lost: no repeat; re-check finds it by lead token and id, no second deal", "hubspot", "deal_accepted_response_loss",
      [...done("ok"), action("hubspot.deal", "applied", 1, [eq("detail_via", "lookup"), eq("detail_created", true), eq("detail_verified", true)]), complete], { evidence: "accepted_response_readback" }), 120),
    deals(leadId("hubspot_deal_response_loss"), 1), sent(email("hubspot_deal_response_loss"), 1),
  ),
  // Probe: Gmail commits the send and holds the response. Expect: no resend; the initial lookup (right after
  // the timeout, per the agreed schedule) confirms it; then the event. Evidence: as above + Gmail count.
  twin(
    eventually(faulted("gmail_send_response_loss", "Email accepted, response lost: no resend; initial lookup confirms it, then booked", "gmail", "direct_send_accepted_response_loss",
      [...done("ok"), action("gmail.send_followup", "applied", 1, [eq("detail_confirmedBy", "confirmation lookup 1/3"), eq("detail_sendAttempts", 1)]), action("calendar.followup_event", "applied"), complete], { evidence: "accepted_response_readback" }), 120),
    sent(email("gmail_send_response_loss"), 1), events(leadId("gmail_send_response_loss"), 1), posted(leadId("gmail_send_response_loss"), 1),
  ),
  // Probe: send accepted, response lost, every lookup unavailable; a real runtime restart inside the window.
  // Expect: initial lookup, then 2 scheduled lookups (anchored to the send, durable across the restart), never a
  // resend, no event, then the Slack handoff. Evidence: refusal, saved lookup log, run events, twin state.
  // TIMING IS COMPRESSED in this relay suite (LEAD_EMAIL_CONFIRM_INTERVAL_MS=20000, lookups at +0/+20 s/+40 s):
  // this check measures the behavior, not the 15/30-minute spacing (see email_confirmation_spacing_30_minutes).
  twin(
    eventually(check("gmail_unresolved_handoff", "Email outcome unresolvable: initial + 2 scheduled lookups (across a restart), no resend, no event, Slack handoff", [
      submit("gmail_unresolved_handoff"),
      restart,
    ], runs([
      ...done("partial"),
      action("gmail.send_followup", "failed", 1, [eq("errorCode", "gmail:delivery_unconfirmed"), contains("error", "after 3 lookups (+0.")]),
      event("confirmation lookup 1/3 at +0."),
      event("confirmation lookup 2/3 at "),
      ...skipped("calendar.followup_event"),
      handoff("gmail.send_followup"),
    ]), { fault: { provider: "gmail", scenario: "direct_send_accepted_lookup_unavailable", evidence: "refusal" } }), 180),
    sent(email("gmail_unresolved_handoff"), 1), events(leadId("gmail_unresolved_handoff"), 0),
    posted(leadId("gmail_unresolved_handoff"), 1, `<@${OWNER}>`, "blocked at *follow-up email (Gmail)*", email("gmail_unresolved_handoff"), "MAY have been sent", "rfc822msgid:"),
  ),

  // ---- Refusals, permissions and rate limits: nothing accepted, bounded re-checks, then a person ----
  twin(
    eventually(faulted("gmail_send_rejected", "Send always refused: at most 3 tries, nothing sent or booked, handoff", "gmail", "direct_send_rejected",
      [...done("partial"), action("gmail.send_followup", "failed"), ...skipped("calendar.followup_event"), handoff("gmail.send_followup")]), 120),
    sent(email("gmail_send_rejected"), 0), events(leadId("gmail_send_rejected"), 0), posted(leadId("gmail_send_rejected"), 1, "nothing was sent to the lead"),
  ),
  twin(
    eventually(faulted("gmail_send_rejected_once", "Send refused once: re-checked, sent once, then booked", "gmail", "direct_send_rejected_once",
      [...done("ok"), action("gmail.send_followup", "applied", 1, [eq("detail_sendAttempts", 2)]), action("calendar.followup_event", "applied"), complete]), 120),
    sent(email("gmail_send_rejected_once"), 1), events(leadId("gmail_send_rejected_once"), 1),
  ),
  twin(
    faulted("gmail_auth_failure", "Gmail auth failure: blocked at email, nothing sent or booked, handoff", "gmail", "auth_failure",
      [...done("partial"), action("gmail.send_followup", "failed"), ...skipped("calendar.followup_event"), handoff("gmail.send_followup")]),
    deals(leadId("gmail_auth_failure"), 1), sent(email("gmail_auth_failure"), 0), events(leadId("gmail_auth_failure"), 0), posted(leadId("gmail_auth_failure"), 1),
  ),
  twin(
    eventually(faulted("gmail_rate_limited", "Gmail rate limited: bounded re-checks, nothing sent, handoff", "gmail", "rate_limited",
      [...done("partial"), action("gmail.send_followup", "failed"), ...skipped("calendar.followup_event"), handoff("gmail.send_followup")]), 150),
    sent(email("gmail_rate_limited"), 0), events(leadId("gmail_rate_limited"), 0),
  ),
  twin(
    faulted("hubspot_auth_failure", "HubSpot auth failure: blocked at contact, nothing downstream, handoff", "hubspot", "auth_failure",
      [...done("partial"), action("hubspot.contact", "failed"), ...skipped("hubspot.deal", "gmail.send_followup", "calendar.followup_event"), handoff("hubspot.contact")]),
    deals(leadId("hubspot_auth_failure"), 0), sent(email("hubspot_auth_failure"), 0), events(leadId("hubspot_auth_failure"), 0), posted(leadId("hubspot_auth_failure"), 1, "Nothing was emailed to the lead"),
  ),
  twin(
    eventually(faulted("hubspot_scope_denied", "HubSpot writes forbidden: bounded re-checks, handoff, nothing downstream", "hubspot", "scope_denied",
      [...done("partial"), action("hubspot.contact", "failed"), ...skipped("hubspot.deal", "gmail.send_followup", "calendar.followup_event"), handoff("hubspot.contact")]), 120),
    contacts(email("hubspot_scope_denied"), 0), deals(leadId("hubspot_scope_denied"), 0), sent(email("hubspot_scope_denied"), 0),
  ),
  twin(
    eventually(faulted("hubspot_rate_limited", "HubSpot rate limited: bounded re-checks, no writes, no email, handoff", "hubspot", "rate_limited",
      [...done("partial"), action("hubspot.contact", "failed"), ...skipped("hubspot.deal", "gmail.send_followup", "calendar.followup_event"), handoff("hubspot.contact")]), 150),
    contacts(email("hubspot_rate_limited"), 0), deals(leadId("hubspot_rate_limited"), 0), sent(email("hubspot_rate_limited"), 0),
  ),
  twin(
    faulted("calendar_auth_failure", "Calendar auth failure: email stays single, handoff for the event only", "google-calendar", "auth_failure",
      [...done("partial"), action("gmail.send_followup", "applied"), action("calendar.followup_event", "failed"), handoff("calendar.followup_event")]),
    sent(email("calendar_auth_failure"), 1), events(leadId("calendar_auth_failure"), 0), posted(leadId("calendar_auth_failure"), 1, "Only the calendar event is missing"),
  ),
  twin(
    eventually(faulted("calendar_rate_limited", "Calendar rate limited: bounded re-checks, no second email, handoff", "google-calendar", "rate_limited",
      [...done("partial"), action("gmail.send_followup", "applied"), action("calendar.followup_event", "failed"), handoff("calendar.followup_event")]), 150),
    sent(email("calendar_rate_limited"), 1), events(leadId("calendar_rate_limited"), 0),
  ),

  // ---- Slack: the notification itself fails or is slow ------------------------------------------
  twin(
    faulted("slack_channel_not_found", "Slack channel_not_found: notification recorded failed, never as sent", "slack", "channel_not_found",
      [...done("partial"), ...allApplied, action("slack.notify_team", "failed", 1, [eq("errorCode", "slack:channel_not_found")])]),
    posted(leadId("slack_channel_not_found"), 0), sent(email("slack_channel_not_found"), 1),
  ),
  twin(
    faulted("slack_not_in_channel", "Slack not_in_channel: notification recorded failed", "slack", "not_in_channel",
      [...done("partial"), ...allApplied, action("slack.notify_team", "failed", 1, [eq("errorCode", "slack:not_in_channel")])]),
    posted(leadId("slack_not_in_channel"), 0),
  ),
  twin(
    faulted("slack_missing_scope", "Slack missing_scope: notification recorded failed", "slack", "missing_scope",
      [...done("partial"), ...allApplied, action("slack.notify_team", "failed", 1, [eq("errorCode", "slack:missing_scope")])]),
    posted(leadId("slack_missing_scope"), 0),
  ),
  twin(
    eventually(faulted("slack_rate_limited", "Slack rate limited: bounded re-checks, recorded failed, effects single", "slack", "rate_limited",
      [...done("partial"), ...allApplied, action("slack.notify_team", "failed")]), 150),
    posted(leadId("slack_rate_limited"), 0), sent(email("slack_rate_limited"), 1), events(leadId("slack_rate_limited"), 1),
  ),
  // Probe: every Slack response delayed ~3 s; the post times out at 2 s (the twin still commits it).
  // Expect: no blind repost; the patient history read finds the marker; exactly one post.
  twin(
    eventually(faulted("slack_slow_network_single_post", "Slack slower than the client timeout: the post is found in history, never posted twice", "slack", "slow_network",
      [...done("ok"), ...allApplied, action("slack.notify_team", "applied", 1, [eq("detail_via", "readback"), eq("detail_kind", "complete")])], { evidence: "accepted_response_readback" }), 120),
    posted(leadId("slack_slow_network_single_post"), 1),
  ),

  // ---- Crash/restart, stale workers, mid-run state changes, isolation, ownership ----------------------
  // Probe: the runtime is killed (SIGKILL) while the Gmail send it started is held by the twin; restarted on
  // the same storage. Expect: the stale claim is taken over after 20 s, the "maybe sent" marker forces a
  // lookup instead of a resend, the email is confirmed, then the event. Evidence: takeover event, sendAttempts 1,
  // twin Gmail count 1, changed runtime instance id.
  twin(
    eventually(check("restart_during_confirmation", "Runtime killed while its send is in flight: stale claim taken over, lookup confirms, never resent", [
      submitNoWait("restart_during_confirmation"),
      restart,
    ], runs([...done("ok"), event("gmail.send_followup: took over a stale claim"), action("gmail.send_followup", "applied", 1, [eq("detail_confirmedBy", "confirmation lookup 1/3"), eq("detail_sendAttempts", 1)]), action("calendar.followup_event", "applied"), complete]), { fault: { provider: "gmail", scenario: "direct_send_accepted_response_loss", evidence: "accepted_response_readback" } }), 150),
    sent(email("restart_during_confirmation"), 1), events(leadId("restart_during_confirmation"), 1), posted(leadId("restart_during_confirmation"), 1),
  ),
  // Probe: while the run waits on the deal re-check, the lead is resubmitted with a different name and email.
  // Expect: it joins the run; the first submission's data is used; nothing goes to the changed address.
  twin(
    eventually(faulted("midrun_resubmission_while_waiting", "Resubmission with changed details while the run waits: joins it, first data used, nothing to the new address", "hubspot", "deal_accepted_response_loss",
      [...done("ok"), ...allApplied, complete], { evidence: "accepted_response_readback", extra: [submit("midrun_resubmission_while_waiting", { name: "Changed Person", email: "changed-midrun@example.test" }, { runId: "midrun-b-{{run_id}}" })] }), 120),
    deals(leadId("midrun_resubmission_while_waiting"), 1, "Ada Lovelace"), sent(email("midrun_resubmission_while_waiting"), 1), sent("changed-midrun@example.test", 0), contacts("changed-midrun@example.test", 0),
  ),
  // Probe: two different leads in the same check. Expect: two runs, each with only its own records.
  twin(
    check("two_leads_isolated", "Two different leads: two runs, each with only its own contact, deal, email, event and post", [
      start("two_leads_isolated", { leadId: "L-iso-a", name: "Ada Lovelace", email: "iso-a@example.test" }, { runId: "iso-a-{{run_id}}" }),
      start("two_leads_isolated", { leadId: "L-iso-b", name: "Grace Hopper", email: "iso-b@example.test" }, { runId: "iso-b-{{run_id}}" }),
    ], runs([...done("ok"), ...allApplied, complete], 2)),
    // At most 8 provider assertions per check (server limit): contacts are covered by the runs' applied contact steps.
    deals("L-iso-a", 1, "Ada Lovelace"), deals("L-iso-b", 1, "Grace Hopper"),
    sent("iso-a@example.test", 1), sent("iso-b@example.test", 1), events("L-iso-a", 1), events("L-iso-b", 1), posted("L-iso-a", 1), posted("L-iso-b", 1),
  ),
  // ---- Last: this fault permanently expires the session's HubSpot twin credential,
  //      so any check after it would be blocked at HubSpot (observed in revision 1, attempt 3).
  twin(
    eventually(faulted("hubspot_token_expired", "HubSpot token dies mid-run: stops at the failing step, handoff, no email", "hubspot", "token_expired",
      [...done("partial"), action("slack.notify_team", "applied", 1, [eq("detail_kind", "blocked")]), ...skipped("gmail.send_followup", "calendar.followup_event")]), 120),
    deals(leadId("hubspot_token_expired"), 0), sent(email("hubspot_token_expired"), 0), events(leadId("hubspot_token_expired"), 0),
  ),

  // ---- Declared, not measurable with the current backend/runner --------------------------------------
  blocked("email_confirmation_spacing_30_minutes", "The confirmation lookups run right after the unknown send and 15 and 30 minutes after it, then the handoff", "setup_missing",
    "Measured attempt (rev 2, vr_7f0015df...): the real-time check reached its +15.0 min lookup, then the managed relay lease expired (manage_tunnel expires_in_seconds 1800; a second open is refused until close, and a new tunnel gets a new URL the configured run cannot follow), so the observation returned HTTP 503 and every later check lost its app. The execution budget allows 3300 s but no relay lease outlives 1800 s, and the 30-minute schedule plus setup needs more. Measured separately through the caller-executed arm/probe path (provider traffic, app_verified false); see the evidence record.",
    ["receipt vr_7f0015df3bd648dc9b52e798d52ea98c: email_confirmation_spacing_30_minutes 'state observation returned HTTP 503'", "manage_tunnel open: expires_in_seconds 1800; second open: 'Close the current tunnel before opening another'", "capabilities.http_contract_limits.execution_budget_seconds.maximum 3300"]),
  blocked("midrun_provider_change_by_person", "A person creates the lead's deal or sends the follow-up by hand while the run waits; the run adopts it instead of duplicating", "setup_missing",
    "Driving a provider-side change between app actions needs a qualified external_operator input; discovery returns qualified_external_inputs: [] for hubspot, gmail, google-calendar and slack. The app's reconcile-first lookups would adopt such records (deal by lead token, email by Message-ID); covered by local tests only.",
    ["validate_integration provider_contracts.<provider>.qualified_external_inputs = [] (session vs_1e66584ab3b8)", "acme-ops/src/workflows/lead-follow-up.ts reconcileThenWrite / sendFollowUp pre-send lookup", "acme-ops/test/lead-follow-up.test.ts 'an existing contact is adopted'"]),
  blocked("multi_worker_shared_store", "Two live workers drive the same stored run at once (multi-container): one claim owner, no duplicate effect, the run still finishes", "setup_missing",
    "The relay runner starts exactly one runtime process with a local file store; FetchSandbox cannot start a second worker against the same storage. Measured locally only: two engines on one store race a stale claim (one takeover, no resend), which exposed and fixed a stranded-WAITING settle race in the engine.",
    ["acme-ops/verify/relay-proof.mjs startApp (single process)", "acme-ops/src/kit/store.ts FileStore (single-process)", "acme-ops/test/lead-follow-up.test.ts 'stale worker ... taken over'"]),
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
    // Compressed for the relay suite (production 15 min): the managed relay lease (1800 s) cannot hold the
    // real 30-minute schedule; that timing is measured through the caller-executed path instead.
    LEAD_EMAIL_CONFIRM_INTERVAL_MS: "20000",
    PROVIDER_TIMEOUT_MS: "4000",
    SLACK_TIMEOUT_MS: "2000",
    LEAD_RECONCILE_READ_TIMEOUT_MS: "15000",
    LEAD_RETRY_INTERVAL_MS: "15000",
    STALE_RUN_MS: "20000",
    STALE_CLAIM_MS: "20000",
    LEAD_FOLLOWUP_SLACK_CHANNEL: CHANNEL,
    LEAD_FOLLOWUP_OWNER_SLACK_ID: OWNER,
    TICK_INTERVAL_MS: "1000",
  },
  applicationConfig: { execution_budget_seconds: 1500 },
  // The runner polls fast once this check starts, so the restart lands while the send is in flight.
  restartWatch: "restart-during-confirmation",
  maxRunMinutes: 40,
  context: {
    goal: "Validate the lead-follow-up runtime contract: lead form submission (leadId, name, email) → HubSpot contact found or created, exactly one deal per lead, exactly one Gmail follow-up email, a Calendar follow-up only after the email is confirmed, and a Slack completion or blocked-step handoff to a named person. Repeated and concurrent submissions are safe; a timeout is an unknown outcome reconciled before any repeat; an unconfirmed email gets an initial lookup and lookups 15 and 30 minutes after the send, then a person; a worker that dies mid-call is taken over without a resend.",
    workflow: "POST /invocations {action:start,input:{leadId,name,email}}; run id lead-<leadId>; reconcile-first steps (contact by email, deal by lead token + GET, email by RFC Message-ID + GET, event by derived id, Slack by marker in history); deferred re-checks woken by the runtime tick; stale claims taken over by reentrant steps. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations", "GET /verify/runtime", "GET /verify/runs/{run_id}/cases/{case}/runs"],
    state_store: "Durable file store (compare-and-swap runs, per-effect claims), reused across restarts; run records exposed read-only and bearer-protected.",
  },
  checks,
  scope_review: checks.map((c) => ({ check_id: c.id, classification: "in_scope", reason: "Promised by the lead follow-up request (no duplicates, safe resubmission, reconcile unknown outcomes, agreed email schedule then a person, recovery and isolation).", evidence: ["acme-ops/src/workflows/lead-follow-up.ts"] })),
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["invalid_input_rejected"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: "The deal is created without amount, currency or quantity; no money moves.",
    duplicate_replay: ["resubmitted_lead_joins_run", "hubspot_deal_response_loss", "gmail_send_response_loss", "existing_contact_adopted", "slack_slow_network_single_post"],
    concurrency: ["concurrent_first_submissions", "multi_worker_shared_store"],
    ordering_and_stale_events: ["midrun_resubmission_while_waiting", "midrun_provider_change_by_person", "baseline"],
    delayed_or_missing_events: ["gmail_send_response_loss", "gmail_unresolved_handoff", "email_confirmation_spacing_30_minutes"],
    provider_auth_and_scopes: ["hubspot_auth_failure", "hubspot_scope_denied", "hubspot_token_expired", "gmail_auth_failure", "calendar_auth_failure", "slack_missing_scope", "slack_not_in_channel", "slack_channel_not_found"],
    rate_limit_server_error_timeout: ["hubspot_rate_limited", "gmail_rate_limited", "calendar_rate_limited", "slack_rate_limited", "slack_slow_network_single_post"],
    accepted_effect_response_loss: ["hubspot_deal_response_loss", "gmail_send_response_loss", "gmail_unresolved_handoff", "restart_during_confirmation"],
    partial_effects_and_recovery: ["gmail_send_rejected", "gmail_send_rejected_once", "calendar_auth_failure", "hubspot_token_expired", "slack_rate_limited", "restart_during_confirmation"],
    restart_and_durability: ["restart_during_confirmation", "gmail_unresolved_handoff", "multi_worker_shared_store"],
    reconciliation: ["reconcile_reads_back", "hubspot_deal_response_loss", "gmail_send_response_loss", "slack_slow_network_single_post"],
    cancellation_refund_entitlements: "The workflow promises no cancellation, refund or entitlement behavior.",
    data_and_privacy_boundaries: "Synthetic example.test leads only. The lead's name and email appear in the internal sales channel's handoff (requested); the follow-up email goes only to the submitted address (midrun_resubmission_while_waiting asserts nothing reaches a changed address); no calendar invitation is sent to the lead.",
    cleanup_and_isolation: ["two_leads_isolated", "concurrent_first_submissions", "invalid_input_rejected"],
  },
  evidence: ["acme-ops/src/workflows/lead-follow-up.ts", "acme-ops/src/kit/engine.ts (runKey, RetryLater, stale claims, stale runs)", "acme-ops/src/kit/http.ts", "acme-ops/src/providers/{hubspot,google,slack}.ts", "acme-ops/test/lead-follow-up.test.ts"],
};
