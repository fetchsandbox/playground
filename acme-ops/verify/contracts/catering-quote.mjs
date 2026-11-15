import { action, agent, all, blocked, check, command, eq, noAction, proofNow, restart, runs, start, startAgain } from "./lib.mjs";

// Executable expectations for the catering quote-to-booking runtime (restaurant
// owner, e.g. a pizza shop). Providers are the FetchSandbox twins of HubSpot
// (CRM), Google Calendar, Gmail (direct send) and Stripe (customer + invoice).
//
// Every check uses its own customer, inquiry id and calendar slot, so checks
// never share provider state. Times are relative to PROOF_NOW.
const OWNER = "U_OWNER_TONY";
const CUSTOMER_REPLY = "inbox:customer-reply";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const today = Math.floor(proofNow() / DAY) * DAY;
/** 18:00 UTC on day `n` from now (n ≥ 3 keeps every case past the 48 h lead time). */
const slot = (n) => new Date(today + n * DAY + 18 * HOUR).toISOString();
const ACCEPT = "quote.customer_acceptance";
/**
 * A value compared on the element already selected by id/kind. Unlike eq(), it is not
 * `required` on every element of the collection: fields such as detail.amountDue exist
 * only on the action they describe (a required leaf inside actions[*] demands it everywhere).
 */
const has = (select, equals) => ({ select, equals });
/** Independent Gmail twin read-back: exactly `count` messages stored with this To header. */
const sentTo = (code, count) => ({
  provider: "gmail",
  collection: "messages",
  assertion: { select: "records[*]", count, required: true, where: [{ select: "payload.headers[*]", count: 1, where: [has("name", "To"), has("value", `${code}@party.example.test`)] }] },
});

let n = 3;
const slots = {};
const slotOf = (code) => (slots[code] ??= slot(n++));

/** One catering request. `code` keeps inquiry ids short (≤ 60 chars with the run id). */
const request = (code, over = {}) => {
  const { event, ...rest } = over;
  return {
    inquiryId: `CAT-${code}-{{run_id}}`,
    revision: 1,
    source: "email",
    customer: { name: "Dana Rivera", email: `${code}@party.example.test`, phone: "+1 555 0100" },
    event: { start: slotOf(code), durationMinutes: 120, headcount: 30, fulfillment: "delivery", address: "12 Elm St, Springfield", ...event },
    package: "classic",
    owner: { name: "Tony's Pizza", email: "owner@tonys-pizza.example.test", phone: "+1 555 0199", calendarId: "primary", timeZone: "America/New_York" },
    approvers: [OWNER],
    ...rest,
  };
};
const quoteId = (code, rev = 1) => `CAT-${code}-{{run_id}}-r${rev}`;
const approve = (step = 1) => command("decide", step, { decision: "approve", userId: OWNER });
const accept = (step = 1, userId = OWNER, value = "approve", expect = 200) => command("signal", step, { actionId: ACCEPT, value, userId }, expect);

/** The full happy path's saved effects on one run. */
const booked = (total) => [
  action("gmail.send_quote", "applied"),
  action("stripe.record_quote", "applied"),
  action(ACCEPT, "applied"),
  action("calendar.book_event", "applied"),
  action("stripe.send_invoice", "applied", 1, [has("detail.amountDue", total)]),
  action("gmail.send_confirmation", "applied"),
];

const baselineCode = "base";

export const checks = [
  check(
    "baseline",
    "A 30-guest delivery request is quoted at $18/head + $35 delivery, sent after the owner approves, and once the customer accepts: calendar booked, Stripe invoice sent, confirmation sent, CRM customer, day-before reminder scheduled",
    [start("baseline", request(baselineCode)), approve(), accept()],
    runs([
      eq("phase", "WAITING"),
      eq("output.decision", "quote"),
      eq("output.totalMinor", 57500),
      action("hubspot.upsert_contact", "applied"),
      ...booked(57500),
      action("hubspot.mark_customer", "applied"),
      action("gmail.send_reminder", "scheduled"),
    ]),
    {
      provider_assertions: [
        { provider: "stripe", collection: "invoices", assertion: { select: "records[*]", count: 1, required: true, where: [has("metadata.catering_quote", quoteId(baselineCode)), eq("amount_due", 57500), eq("status", "open")] } },
        sentTo(baselineCode, 2),
        { provider: "google-calendar", collection: "events", assertion: { select: "records[*]", count: 1, required: true, where: [has("extendedProperties.private.cateringQuote", quoteId(baselineCode)), eq("status", "confirmed")] } },
      ],
    },
  ),
  check("stranger_cannot_approve", "Someone who isn't an approver can't release a quote: it stays parked and nothing is booked", [start("stranger_cannot_approve", request("strapp")), command("decide", 1, { decision: "approve", userId: "U_STRANGER" }, 403)], runs([eq("phase", "AWAITING_APPROVAL"), action("gmail.send_quote", "pending_approval"), action("calendar.book_event", "scheduled"), action("stripe.send_invoice", "scheduled")])),
  check("owner_rejects_quote", "The owner rejects the quote: nothing is sent, booked or invoiced", [start("owner_rejects_quote", request("ownrej")), command("decide", 1, { decision: "reject", userId: OWNER })], runs([eq("phase", "REJECTED"), action("gmail.send_quote", "rejected"), action("stripe.record_quote", "scheduled"), action("calendar.book_event", "scheduled")])),
  check("customer_declines", "The customer says no: no booking, invoice, confirmation or reminder, and the run closes", [start("customer_declines", request("custno")), approve(), accept(1, CUSTOMER_REPLY, "reject")], runs([eq("phase", "DONE"), action(ACCEPT, "rejected"), action("calendar.book_event", "skipped"), action("stripe.send_invoice", "skipped"), action("gmail.send_confirmation", "skipped"), action("gmail.send_reminder", "skipped")])),
  check("stranger_cannot_accept", "Only the owner can approve an emailed acceptance; strangers and the inbox actor cannot book", [start("stranger_cannot_accept", request("stracc")), approve(), accept(1, "U_STRANGER", "approve", 403), accept(1, CUSTOMER_REPLY, "approve", 403)], runs([eq("phase", "WAITING"), action(ACCEPT, "awaiting_signal"), action("calendar.book_event", "scheduled")])),
  check("accept_before_quote_sent_ignored", "An acceptance recorded before the owner approved the quote doesn't book anything", [start("accept_before_quote_sent_ignored", request("early")), accept(), approve()], runs([action("gmail.send_quote", "applied"), action(ACCEPT, "skipped"), action("calendar.book_event", "skipped"), action("stripe.send_invoice", "skipped")])),
  check("negotiated_within_floor", "A counter-offer of $16/head (floor $15.30) is honoured, and the invoice is for the negotiated total", [start("negotiated_within_floor", request("nego", { requestedPerHeadMinor: 1600 })), approve(), accept()], runs([eq("output.perHeadMinor", 1600), eq("output.negotiation", "accepted_counter"), eq("output.totalMinor", 51500), ...booked(51500)])),
  check("counter_below_floor_countered", "A counter-offer of $12/head is countered at the $15.30 floor, not accepted", [start("counter_below_floor_countered", request("floor", { requestedPerHeadMinor: 1200 }))], runs([eq("output.perHeadMinor", 1530), eq("output.negotiation", "countered"), eq("output.totalMinor", 49400), action("gmail.send_quote", "pending_approval")])),
  check(
    "superseded_revision_not_accepted",
    "After a revised quote is sent, accepting the old revision books nothing; accepting the new one books once at the new price",
    [
      start("superseded_revision_not_accepted", request("super")),
      approve(1),
      start("superseded_revision_not_accepted", request("super", { revision: 2, requestedPerHeadMinor: 1600 }), { runId: "superseded-r2-{{run_id}}" }),
      approve(3),
      accept(1),
      accept(3),
    ],
    {
      all_of: [
        runs([], 2),
        runs([eq("output.quoteId", quoteId("super", 1)), action(ACCEPT, "skipped"), action("calendar.book_event", "skipped"), action("stripe.send_invoice", "skipped")]),
        runs([eq("output.quoteId", quoteId("super", 2)), ...booked(51500)]),
      ],
    },
  ),
  check(
    "booked_inquiry_not_requoted",
    "Once a quote is accepted, a later counter-offer on the same inquiry goes to the owner instead of a second quote",
    [start("booked_inquiry_not_requoted", request("rebook")), approve(1), accept(1), start("booked_inquiry_not_requoted", request("rebook", { revision: 2, requestedPerHeadMinor: 1500 }), { runId: "rebook-r2-{{run_id}}" })],
    { all_of: [runs([eq("output.quoteId", quoteId("rebook", 1)), ...booked(57500)]), runs([eq("output.quoteId", quoteId("rebook", 2)), eq("output.decision", "manual"), action("gmail.notify_owner", "applied"), noAction("gmail.send_quote")])] },
  ),
  check("headcount_below_minimum_declined", "A 6-guest request is declined (minimum 10); the decline waits for the owner", [start("headcount_below_minimum_declined", request("small", { event: { headcount: 6 } }))], runs([eq("output.decision", "decline"), action("gmail.send_decline", "pending_approval"), noAction("gmail.send_quote")])),
  check("short_notice_declined", "A request for 20 hours from now is declined (48 h lead time)", [start("short_notice_declined", request("short", { event: { start: new Date(proofNow() + 20 * HOUR).toISOString() } }))], runs([eq("output.decision", "decline"), action("gmail.send_decline", "pending_approval"), noAction("gmail.send_quote")])),
  check("date_conflict_declined", "A slot the kitchen is already booked for is declined, and the owner-approved decline is sent", [start("date_conflict_declined", request("clash")), approve()], runs([{ select: "agents[*]", count: 1, required: true, where: [eq("name", "availability"), eq("status", "ok"), has("summary", "kitchen busy (1 booking(s))")] }, eq("output.decision", "decline"), action("gmail.send_decline", "applied"), noAction("gmail.send_quote")])),
  check("large_party_to_owner", "A 200-guest request goes to the owner; the customer gets nothing automatic", [start("large_party_to_owner", request("large", { event: { headcount: 200 } }))], runs([eq("phase", "DONE"), eq("output.decision", "manual"), action("gmail.notify_owner", "applied"), noAction("gmail.send_quote"), noAction("gmail.send_decline")])),
  check("invalid_input_rejected", "A delivery request without an address is rejected before any agent runs", [start("invalid_input_rejected", request("bad", { event: { address: undefined } }), { expectStatus: 400 })], runs([], 0)),
  check("duplicate_start", "A re-delivered request is one run; its CRM write, quote and Stripe record happen once", [start("duplicate_start", request("dup")), startAgain("duplicate_start", request("dup")), approve()], runs([action("hubspot.upsert_contact", "applied", 1, [eq("attempts", 1)]), action("gmail.send_quote", "applied", 1, [eq("attempts", 1)]), action("stripe.record_quote", "applied", 1, [eq("attempts", 1)])])),
  check("concurrent_start", "Four simultaneous re-deliveries of a request create one run, one CRM write and one parked quote", [start("concurrent_start", request("conc")), startAgain("concurrent_start", request("conc"), 1, 4)], runs([eq("phase", "AWAITING_APPROVAL"), action("hubspot.upsert_contact", "applied", 1, [eq("attempts", 1)]), action("gmail.send_quote", "pending_approval")])),
  check("concurrent_acceptance", "Four simultaneous acceptances book the calendar once and send one invoice", [start("concurrent_acceptance", request("cacc")), approve(), { ...accept(), concurrency: 4 }], runs([action("calendar.book_event", "applied", 1, [eq("attempts", 1)]), action("stripe.send_invoice", "applied", 1, [eq("attempts", 1)]), action("gmail.send_confirmation", "applied", 1, [eq("attempts", 1)])])),
  check(
    "gmail_send_rejected_then_resumed",
    "Gmail refuses the approved quote: nothing downstream happens; after Gmail recovers, resume sends it once and the quote can be accepted",
    [start("gmail_send_rejected_then_resumed", request("gmrej")), approve(), { provider_control: { provider: "gmail", scenario: "default" } }, command("resume", 1)],
    runs([action("gmail.send_quote", "applied", 1, [eq("attempts", 2), has("detail.recovered", false)]), action("stripe.record_quote", "applied"), action(ACCEPT, "awaiting_signal")]),
    { fault: { provider: "gmail", scenario: "direct_send_rejected", evidence: "refusal" }, provider_assertions: [sentTo("gmrej", 1)] },
  ),
  check(
    "gmail_response_lost_recovered",
    "Gmail accepts the quote but the response is lost: the app finds the sent message by Message-ID and records it, without sending a second email",
    [start("gmail_response_lost_recovered", request("gmlost")), approve()],
    runs([action("gmail.send_quote", "applied", 1, [eq("attempts", 1), has("detail.recovered", true)]), action("stripe.record_quote", "applied")]),
    { fault: { provider: "gmail", scenario: "direct_send_accepted_response_loss", evidence: "accepted_response_readback" }, provider_assertions: [sentTo("gmlost", 1)] },
  ),
  check(
    "gmail_lookup_unavailable_not_resent",
    "Gmail's response is lost AND the mailbox lookup is down: the send is marked uncertain and not resent",
    [start("gmail_lookup_unavailable_not_resent", request("gmunk")), approve()],
    runs([action("gmail.send_quote", "failed", 1, [has("errorCode", "gmail:send_uncertain")]), action("stripe.record_quote", "scheduled")]),
    { fault: { provider: "gmail", scenario: "direct_send_accepted_lookup_unavailable", evidence: "refusal" }, provider_assertions: [sentTo("gmunk", 1)] },
  ),
  check("calendar_unavailable_to_owner", "The calendar can't be read: no date is promised; the owner is told", [start("calendar_unavailable_to_owner", request("calout"))], all(runs([agent("availability", "failed")]), runs([eq("output.decision", "manual")]), runs([action("gmail.notify_owner", "applied")]), runs([noAction("gmail.send_quote")])), { fault: { provider: "google-calendar", scenario: "rate_limited", evidence: "refusal" } }),
  check("stripe_unavailable_to_owner", "Billing can't be read: the request goes to the owner instead of a quote that might double-book", [start("stripe_unavailable_to_owner", request("strout"))], all(runs([agent("billing-lookup", "failed")]), runs([eq("output.decision", "manual")]), runs([action("gmail.notify_owner", "applied")]), runs([noAction("gmail.send_quote")])), { fault: { provider: "stripe", scenario: "rate_limited", evidence: "refusal" } }),
  check("hubspot_down_quote_continues", "A HubSpot auth failure skips the CRM update; the quote still waits for the owner", [start("hubspot_down_quote_continues", request("hsout"))], all(runs([agent("crm-lookup", "failed")]), runs([noAction("hubspot.upsert_contact")]), runs([action("gmail.send_quote", "pending_approval")])), { fault: { provider: "hubspot", scenario: "auth_failure", evidence: "refusal" } }),
  check("restart_awaiting_acceptance", "A sent quote waiting for the customer survives a runtime restart and books once when accepted", [start("restart_awaiting_acceptance", request("restart")), approve(), restart, accept()], runs([action("gmail.send_quote", "applied", 1, [eq("attempts", 1)]), action(ACCEPT, "applied"), action("calendar.book_event", "applied", 1, [eq("attempts", 1)]), action("stripe.send_invoice", "applied", 1, [eq("attempts", 1), has("detail.amountDue", 57500)]), action("gmail.send_confirmation", "applied")])),
  check(
    "booking_reconciled_reminder_not_early",
    "After booking, the calendar event and invoice read back as written, and a tick doesn't send the reminder before the day before",
    [start("booking_reconciled_reminder_not_early", request("recon")), approve(), accept(), { method: "POST", path: "/invocations", body: { action: "tick" }, expect_status: 200 }, command("reconcile", 1)],
    runs([
      action("calendar.book_event", "applied", 1, [eq("reconciled", "match")]),
      action("stripe.send_invoice", "applied", 1, [eq("reconciled", "match")]),
      action("gmail.send_reminder", "scheduled", 1, [has("waitUntil", new Date(Date.parse(slotOf("recon")) - DAY).toISOString())]),
    ]),
  ),
  blocked("reminder_sent_day_before", "The customer reminder is sent 24 h before the event (and skipped if the event or invoice was cancelled)", "setup_missing", "The reminder fires at event − 24 h, at least a day after booking; the runtime's timers use the real clock and the verifier's execution budget is under an hour, so the send can't be observed in a twin run. It is exercised with a controlled clock in acme-ops/test/catering-quote.test.ts; here the check above only proves it is scheduled for the right time and not sent early.", ["acme-ops/src/workflows/catering-quote.ts gmail.send_reminder waitUntil", "validate_integration capabilities: execution_budget_seconds maximum 3300; Stripe twin unsupported /v1/test_helpers (no simulated passage of time)"]),
  blocked("quote_expires_unaccepted", "An unanswered quote expires after 7 days (or 48 h before the event) and nothing is booked", "setup_missing", "Expiry is a signal deadline days after sending; it needs the runtime's clock to advance, which a twin run can't do. Covered with a controlled clock in acme-ops/test/catering-quote.test.ts.", ["acme-ops/src/workflows/catering-quote.ts quote.customer_acceptance awaitSignal.deadline"]),
  blocked("inbound_reply_starts_or_accepts", "A customer's email/SMS reply is parsed into a new revision or an acceptance signal", "setup_missing", "Reply parsing belongs to the inbox intake adapter, outside this runtime (which takes the parsed request or signal). The Gmail twin does not simulate users.history or users.watch, so mailbox-driven intake can't be exercised here.", ["validate_integration provider_contracts.gmail.unsupported_operations: /gmail/v1/users/{userId}/history, /watch", "acme-ops/src/workflows/catering-quote.ts CUSTOMER_REPLY_ACTOR"]),
];

/** One existing booking on the owner's calendar, at the slot the date-conflict check asks for. */
async function seed(legs, log) {
  const leg = legs["google-calendar"];
  const startIso = slotOf("clash");
  const res = await fetch(`${leg.base_url.replace(/\/+$/, "")}/calendar/v3/calendars/primary/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${leg.api_key}`, "content-type": "application/json" },
    body: JSON.stringify({ summary: "Private party (existing booking)", start: { dateTime: startIso }, end: { dateTime: new Date(Date.parse(startIso) + 3 * HOUR).toISOString() } }),
  });
  const body = await res.json().catch(() => ({}));
  // Read back through freeBusy, the same operation the app uses.
  const fb = await fetch(`${leg.base_url.replace(/\/+$/, "")}/calendar/v3/freeBusy`, {
    method: "POST",
    headers: { authorization: `Bearer ${leg.api_key}`, "content-type": "application/json" },
    body: JSON.stringify({ timeMin: new Date(Date.parse(startIso) - 2 * HOUR).toISOString(), timeMax: new Date(Date.parse(startIso) + 4 * HOUR).toISOString(), items: [{ id: "primary" }] }),
  });
  const busy = (await fb.json().catch(() => ({})))?.calendars?.primary?.busy ?? [];
  log("seed", `calendar event ${res.status} ${body?.id ?? ""}; freeBusy shows ${busy.length} busy block(s) at ${startIso}`);
  if (!body?.id || busy.length !== 1) throw new Error("calendar seed did not read back");
  return { conflictEvent: body.id, slot: startIso };
}

export default {
  workflow: "catering-quote",
  providers: ["stripe", "hubspot", "gmail", "google-calendar"],
  seed,
  // The Gmail response-loss fault holds the reply until the client gives up; keep that wait short.
  appEnv: { PROVIDER_TIMEOUT_MS: "8000" },
  context: {
    goal: "Prove the catering-quote AgentCore runtime for a restaurant owner: a catering request is priced per head in code (package, headcount, delivery, negotiation floor), sent by Gmail only after the owner approves, and when the customer accepts the latest revision it books the owner's Google Calendar, sends a Stripe invoice due 72 h before, sends a confirmation with follow-up instructions, marks the HubSpot contact a customer and schedules a day-before reminder.",
    workflow: "POST /invocations {action:start} runs CRM, calendar and billing lookups in parallel, decides quote/decline/manual and parks the quote or decline for {action:decide}; {action:signal} on quote.customer_acceptance accepts or declines; {action:resume} retries failed effects; {action:reconcile} re-reads the event and invoice; {action:tick} fires due timers.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
    fixture_requirements: ["One existing event on the owner's primary calendar at the date-conflict slot"],
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["stranger_cannot_approve", "stranger_cannot_accept"],
    schema_and_value_boundaries: ["invalid_input_rejected", "headcount_below_minimum_declined", "short_notice_declined", "large_party_to_owner"],
    amount_currency_quantity: ["baseline", "negotiated_within_floor", "counter_below_floor_countered"],
    duplicate_replay: ["duplicate_start", "booked_inquiry_not_requoted"],
    concurrency: ["concurrent_start", "concurrent_acceptance"],
    ordering_and_stale_events: ["superseded_revision_not_accepted", "accept_before_quote_sent_ignored"],
    delayed_or_missing_events: ["quote_expires_unaccepted", "inbound_reply_starts_or_accepts"],
    provider_auth_and_scopes: ["hubspot_down_quote_continues"],
    rate_limit_server_error_timeout: ["calendar_unavailable_to_owner", "stripe_unavailable_to_owner"],
    accepted_effect_response_loss: ["gmail_response_lost_recovered", "gmail_lookup_unavailable_not_resent"],
    partial_effects_and_recovery: ["gmail_send_rejected_then_resumed", "gmail_lookup_unavailable_not_resent"],
    restart_and_durability: ["restart_awaiting_acceptance"],
    reconciliation: ["booking_reconciled_reminder_not_early"],
    cancellation_refund_entitlements: ["owner_rejects_quote", "customer_declines", "reminder_sent_day_before"],
    data_and_privacy_boundaries: "Customer notes reach only the email drafter (as untrusted facts) and the owner's calendar description, stripped of markup; no customer data is sent anywhere else.",
    cleanup_and_isolation: ["baseline", "date_conflict_declined"],
  },
  evidence: ["acme-ops/src/workflows/catering-quote.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/providers/{stripe,hubspot,google}.ts", "acme-ops/test/catering-quote.test.ts"],
};
