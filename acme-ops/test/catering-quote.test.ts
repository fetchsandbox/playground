import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/kit/store";
import { CUSTOMER_REPLY_ACTOR, POLICY, cateringQuote, decide, invoiceDueSec, negotiate, stateKey, type Input } from "../src/workflows/catering-quote";
import { startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OWNER = "U_OWNER";
const user = { userId: "U_INBOX" };
const T0 = Date.now();
/** An event at 18:00 UTC `days` from now. */
const at = (days: number) => new Date(Math.floor((T0 + days * DAY) / DAY) * DAY + 18 * HOUR).toISOString();
const input = (over: Omit<Partial<Input>, "event"> & { event?: Partial<Input["event"]> } = {}): Input => {
  const { event, ...rest } = over;
  return {
    inquiryId: "CAT-2026-0142",
    revision: 1,
    source: "email",
    customer: { name: "Dana Rivera", email: "dana@party.example", phone: "+1 555 0100" },
    event: { start: at(10), durationMinutes: 120, headcount: 30, fulfillment: "delivery", address: "12 Elm St, Springfield", ...event },
    package: "classic",
    owner: { name: "Tony's Pizza", email: "tony@tonys-pizza.example", phone: "+1 555 0199", calendarId: "primary", timeZone: "America/New_York" },
    approvers: [OWNER],
    ...rest,
  } as Input;
};
const act = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const facts = { calendarConflict: false, inquiryState: "" };

describe("pricing and policy (pure)", () => {
  it("prices per head by package, plus delivery", () => {
    const d = decide(input(), new Date(T0), facts);
    expect(d).toMatchObject({ kind: "quote", perHeadMinor: 1800, foodMinor: 54_000, deliveryMinor: 3500, totalMinor: 57_500, negotiation: "list", quoteId: "CAT-2026-0142-r1" });
    expect(decide(input({ package: "premium", event: { fulfillment: "pickup", address: undefined } }), new Date(T0), facts).totalMinor).toBe(30 * 2600);
  });

  it("negotiates down to a 15% floor, and counters at the floor below it", () => {
    expect(negotiate(1800, undefined)).toEqual({ perHeadMinor: 1800, negotiation: "list", floorPerHeadMinor: 1530 });
    expect(negotiate(1800, 2000).perHeadMinor).toBe(1800);
    expect(negotiate(1800, 1530)).toMatchObject({ perHeadMinor: 1530, negotiation: "accepted_counter" });
    expect(negotiate(1800, 1529)).toMatchObject({ perHeadMinor: 1530, negotiation: "countered" });
    expect(negotiate(1800, 1600)).toMatchObject({ perHeadMinor: 1600, negotiation: "accepted_counter" });
  });

  it("declines below the minimum party, on short notice, too far ahead or on a booked slot", () => {
    const now = new Date(T0);
    expect(decide(input({ event: { headcount: 9 } }), now, facts)).toMatchObject({ kind: "decline", reasons: ["headcount_below_minimum"] });
    expect(decide(input({ event: { headcount: 10 } }), now, facts).kind).toBe("quote");
    expect(decide(input({ event: { start: new Date(T0 + 47 * HOUR).toISOString() } }), now, facts).reasons).toEqual(["short_notice"]);
    expect(decide(input({ event: { start: new Date(T0 + 49 * HOUR).toISOString() } }), now, facts).kind).toBe("quote");
    expect(decide(input({ event: { start: at(200) } }), now, facts).reasons).toEqual(["too_far_ahead"]);
    expect(decide(input(), now, { ...facts, calendarConflict: true }).reasons).toEqual(["date_unavailable"]);
  });

  it("sends large parties, too many rounds, an already-booked inquiry or unknown systems to the owner", () => {
    const now = new Date(T0);
    expect(decide(input({ event: { headcount: 151 } }), now, facts)).toMatchObject({ kind: "manual", reasons: ["large_party"] });
    expect(decide(input({ revision: 4 }), now, facts).reasons).toEqual(["negotiation_rounds_exceeded"]);
    expect(decide(input({ revision: 2 }), now, { ...facts, inquiryState: "CAT-2026-0142-r1|accepted" }).reasons).toEqual(["already_booked"]);
    expect(decide(input(), now, { calendarConflict: null, inquiryState: null }).reasons).toEqual(["availability_unknown", "billing_unavailable"]);
  });

  it("a counter-offer on an already-booked inquiry goes to the owner, even though its own booking now fills the slot", () => {
    // Regression (FetchSandbox attempt 3, booked_inquiry_not_requoted): the booked event made the slot busy,
    // and the revision was declined as "date_unavailable" to a customer who was already booked.
    const d = decide(input({ revision: 2, requestedPerHeadMinor: 1500 }), new Date(T0), { calendarConflict: true, inquiryState: "CAT-2026-0142-r1|accepted" });
    expect(d).toMatchObject({ kind: "manual", reasons: ["already_booked"] });
  });

  it("holds a quote 7 days but never closer than 48 h to the event; invoices fall due 72 h before", () => {
    expect(decide(input(), new Date(T0), facts).validUntil).toBe(new Date(T0 + 7 * DAY).toISOString());
    const soon = at(4);
    expect(decide(input({ event: { start: soon } }), new Date(T0), facts).validUntil).toBe(new Date(Date.parse(soon) - 48 * HOUR).toISOString());
    expect(invoiceDueSec(Date.parse(at(10)), T0)).toBe(Math.floor((Date.parse(at(10)) - 72 * HOUR) / 1000));
    expect(invoiceDueSec(Date.parse(at(3)), T0)).toBe(Math.floor((T0 + DAY) / 1000));
  });

  it("rejects malformed requests", () => {
    expect(cateringQuote.input.safeParse(input({ event: { address: undefined } })).success).toBe(false);
    expect(cateringQuote.input.safeParse(input({ inquiryId: "party for dana" })).success).toBe(false);
    expect(cateringQuote.input.safeParse(input({ owner: { ...input().owner, timeZone: "Mars/Olympus" } })).success).toBe(false);
  });
});

describe("catering-quote runs", () => {
  let w: World;
  let clock: { t: number };
  beforeEach(async () => {
    w = await startWorld();
    clock = { t: Date.now() };
  });
  afterEach(() => w.close());
  const engine = (store = new MemoryStore()) => w.engine(cateringQuote, { store, now: () => clock.t });
  const customerMails = () => w.state.gmail.sent.filter((m) => m.to === "dana@party.example");

  it("uses causal action state when send and acceptance share a frozen timestamp", async () => {
    const e = engine();
    await e.handle({ action: "start", runId: "equal-time", input: input(), requestedBy: user });
    await e.handle({ action: "decide", runId: "equal-time", decision: "approve", userId: OWNER });
    const bypass = await e.handle({ action: "signal", runId: "equal-time", actionId: "quote.customer_acceptance", value: "approve", userId: CUSTOMER_REPLY_ACTOR });
    expect(bypass.status).toBe(403);
    expect(act(bypass.body, "calendar.book_event").status).toBe("scheduled");
    const result = await e.handle({ action: "signal", runId: "equal-time", actionId: "quote.customer_acceptance", value: "approve", userId: OWNER });
    expect(act(result.body, "quote.customer_acceptance").status).toBe("applied");
    expect(act(result.body, "calendar.book_event").status).toBe("applied");
    expect(act(result.body, "quote.customer_acceptance").signal.appliedActionIds).toContain("gmail.send_quote");
  });

  it("quote → owner approval → customer acceptance → calendar, invoice, confirmation, day-before reminder", async () => {
    const e = engine();
    const r = await e.handle({ action: "start", runId: "CAT-2026-0142-r1", input: input(), requestedBy: user });
    expect(r.body.phase).toBe("AWAITING_APPROVAL");
    expect(act(r.body, "gmail.send_quote").status).toBe("pending_approval");
    expect(act(r.body, "hubspot.upsert_contact").status).toBe("applied");
    expect(w.state.gmail.sent).toHaveLength(0);

    expect((await e.handle({ action: "decide", runId: "CAT-2026-0142-r1", decision: "approve", userId: "U_STRANGER" })).status).toBe(403);
    const a = await e.handle({ action: "decide", runId: "CAT-2026-0142-r1", decision: "approve", userId: OWNER });
    expect(a.body.phase).toBe("WAITING");
    expect(act(a.body, "quote.customer_acceptance").status).toBe("awaiting_signal");
    expect(customerMails()).toHaveLength(1);
    expect(customerMails()[0]).toMatchObject({ subject: "Your catering quote CAT-2026-0142-r1: $575.00 for 30 guests" });
    const cus = w.state.stripe.customers.find((c) => c.email === "dana@party.example");
    expect(cus.metadata[stateKey("CAT-2026-0142")]).toBe("CAT-2026-0142-r1|sent");
    expect(w.state.calendar.events).toHaveLength(0);

    expect((await e.handle({ action: "signal", runId: "CAT-2026-0142-r1", actionId: "quote.customer_acceptance", value: "approve", userId: "U_STRANGER" })).status).toBe(403);
    clock.t += HOUR;
    const s = await e.handle({ action: "signal", runId: "CAT-2026-0142-r1", actionId: "quote.customer_acceptance", value: "approve", userId: OWNER });
    expect(s.body.phase).toBe("WAITING");
    expect(cus.metadata[stateKey("CAT-2026-0142")]).toBe("CAT-2026-0142-r1|accepted");
    expect(w.state.calendar.events).toEqual([expect.objectContaining({ start: { dateTime: at(10) }, reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 1440 }, { method: "popup", minutes: 120 }] } })]);
    const inv = w.state.stripe.invoices.find((i) => i.metadata?.catering_quote === "CAT-2026-0142-r1");
    expect(inv).toMatchObject({ status: "open", sent: true, amount_due: 57_500, collection_method: "send_invoice", due_date: Math.floor((Date.parse(at(10)) - 72 * HOUR) / 1000) });
    expect(customerMails()).toHaveLength(2);
    expect(customerMails()[1]!.body).toMatch(/Final headcount: reply to this email or call \+1 555 0199 by/);
    expect(customerMails()[1]!.body).toMatch(/about 2 hours before delivery/);
    expect(w.state.hubspot.contacts[0].properties.lifecyclestage).toBe("customer");
    expect(act(s.body, "gmail.send_reminder")).toMatchObject({ status: "scheduled" });

    // Not before the day before.
    await e.handle({ action: "tick" });
    expect(customerMails()).toHaveLength(2);
    clock.t = Date.parse(at(10)) - POLICY.customerReminderBeforeEventHours * HOUR + 1;
    await e.handle({ action: "tick" });
    expect(customerMails()).toHaveLength(3);
    expect(customerMails()[2]!.subject).toBe("Tomorrow: your catering (CAT-2026-0142-r1)");
    expect(customerMails()[2]!.body).toMatch(/is still open/);
    const done = (await e.handle({ action: "status", runId: "CAT-2026-0142-r1" })).body;
    expect(done.phase).toBe("DONE");

    const rec = (await e.handle({ action: "reconcile", runId: "CAT-2026-0142-r1" })).body;
    expect(act(rec, "calendar.book_event").reconciled).toBe("match");
    expect(act(rec, "stripe.send_invoice").reconciled).toBe("match");
  });

  it("only the latest sent revision can be accepted; a counter-offer within the floor is honoured", async () => {
    const e = engine();
    await e.handle({ action: "start", runId: "r1", input: input(), requestedBy: user });
    await e.handle({ action: "decide", runId: "r1", decision: "approve", userId: OWNER });
    const r2 = await e.handle({ action: "start", runId: "r2", input: input({ revision: 2, requestedPerHeadMinor: 1600 }), requestedBy: user });
    expect(r2.body.output).toMatchObject({ perHeadMinor: 1600, negotiation: "accepted_counter", totalMinor: 51_500 });
    await e.handle({ action: "decide", runId: "r2", decision: "approve", userId: OWNER });
    clock.t += HOUR;
    const old = await e.handle({ action: "signal", runId: "r1", actionId: "quote.customer_acceptance", value: "approve", userId: OWNER });
    expect(act(old.body, "quote.customer_acceptance")).toMatchObject({ status: "skipped", detail: { reason: "superseded by CAT-2026-0142-r2" } });
    expect(act(old.body, "stripe.send_invoice").status).toBe("skipped");
    await e.handle({ action: "signal", runId: "r2", actionId: "quote.customer_acceptance", value: "approve", userId: OWNER });
    expect(w.state.stripe.invoices.filter((i) => i.metadata?.catering_inquiry === "CAT-2026-0142")).toEqual([expect.objectContaining({ amount_due: 51_500 })]);
    expect(w.state.calendar.events).toHaveLength(1);
    // A third revision after booking goes to the owner instead of quoting, even though (as on the
    // real calendar) the booking now shows the slot as busy.
    w.state.calendar.busy.push({ start: at(10), end: new Date(Date.parse(at(10)) + 2 * HOUR).toISOString() });
    const r3 = await e.handle({ action: "start", runId: "r3", input: input({ revision: 3, requestedPerHeadMinor: 1500 }), requestedBy: user });
    expect(r3.body.output).toMatchObject({ decision: "manual", reasons: ["already_booked"] });
  });

  it("an acceptance recorded before the owner approved the quote doesn't book anything", async () => {
    const e = engine();
    await e.handle({ action: "start", runId: "q", input: input(), requestedBy: user });
    await e.handle({ action: "signal", runId: "q", actionId: "quote.customer_acceptance", value: "approve", userId: OWNER });
    clock.t += HOUR;
    const r = await e.handle({ action: "decide", runId: "q", decision: "approve", userId: OWNER });
    expect(act(r.body, "quote.customer_acceptance")).toMatchObject({ status: "skipped", detail: { reason: "acceptance arrived before the quote was sent" } });
    expect(w.state.calendar.events).toHaveLength(0);
    expect(w.state.stripe.invoices.filter((i) => i.metadata?.catering_quote)).toHaveLength(0);
  });

  it("a customer who says no gets nothing further; an owner who rejects sends nothing", async () => {
    const e = engine();
    await e.handle({ action: "start", runId: "q", input: input(), requestedBy: user });
    await e.handle({ action: "decide", runId: "q", decision: "approve", userId: OWNER });
    const r = await e.handle({ action: "signal", runId: "q", actionId: "quote.customer_acceptance", value: "reject", userId: CUSTOMER_REPLY_ACTOR });
    expect(r.body.phase).toBe("DONE");
    for (const id of ["calendar.book_event", "stripe.send_invoice", "gmail.send_confirmation", "gmail.send_reminder"]) expect(act(r.body, id).status).toBe("skipped");

    await e.handle({ action: "start", runId: "q2", input: input({ inquiryId: "CAT-2026-0143" }), requestedBy: user });
    const rej = await e.handle({ action: "decide", runId: "q2", decision: "reject", userId: OWNER });
    expect(rej.body.phase).toBe("REJECTED");
    expect(w.state.gmail.sent.filter((m) => m.subject.includes("CAT-2026-0143"))).toHaveLength(0);
  });

  it("a lost Gmail response is recovered by Message-ID lookup, never sent twice", async () => {
    const e = engine();
    await e.handle({ action: "start", runId: "q", input: input(), requestedBy: user });
    w.state.gmail.loseSendResponses = 1;
    const r = await e.handle({ action: "decide", runId: "q", decision: "approve", userId: OWNER });
    expect(act(r.body, "gmail.send_quote")).toMatchObject({ status: "applied", attempts: 1, detail: { recovered: true } });
    expect(customerMails()).toHaveLength(1);
  });

  it("when the lookup is down too, the send is parked as uncertain and resolved without resending", async () => {
    const e = engine();
    await e.handle({ action: "start", runId: "q", input: input(), requestedBy: user });
    w.state.gmail.loseSendResponses = 1;
    w.state.gmail.lookupDown = true;
    const r = await e.handle({ action: "decide", runId: "q", decision: "approve", userId: OWNER });
    expect(act(r.body, "gmail.send_quote")).toMatchObject({ status: "failed", errorCode: "gmail:send_uncertain" });
    expect(act(r.body, "stripe.record_quote").status).not.toBe("applied");
    w.state.gmail.lookupDown = false;
    const again = await e.handle({ action: "resume", runId: "q" });
    expect(act(again.body, "gmail.send_quote")).toMatchObject({ status: "applied", detail: { recovered: true } });
    expect(customerMails()).toHaveLength(1);
  });

  it("a refused send fails the step; resume sends it once", async () => {
    const e = engine();
    await e.handle({ action: "start", runId: "q", input: input(), requestedBy: user });
    w.faults.push({ method: "POST", path: /messages\/send$/, status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED" } }, times: 1 });
    const r = await e.handle({ action: "decide", runId: "q", decision: "approve", userId: OWNER });
    expect(act(r.body, "gmail.send_quote").status).toBe("failed");
    expect(customerMails()).toHaveLength(0);
    const again = await e.handle({ action: "resume", runId: "q" });
    expect(act(again.body, "gmail.send_quote")).toMatchObject({ status: "applied", detail: { recovered: false } });
    expect(customerMails()).toHaveLength(1);
    // The steps behind the resumed send continue: the quote can still be accepted and booked.
    expect(act(again.body, "stripe.record_quote").status).toBe("applied");
    expect(act(again.body, "quote.customer_acceptance").status).toBe("awaiting_signal");
    clock.t += HOUR;
    const booked = await e.handle({ action: "signal", runId: "q", actionId: "quote.customer_acceptance", value: "approve", userId: OWNER });
    expect(act(booked.body, "gmail.send_confirmation").status).toBe("applied");
  });

  it("an invoice that failed mid-way is resumed on the same draft, not duplicated", async () => {
    const e = engine();
    await e.handle({ action: "start", runId: "q", input: input(), requestedBy: user });
    await e.handle({ action: "decide", runId: "q", decision: "approve", userId: OWNER });
    w.faults.push({ method: "POST", path: /\/finalize$/, status: 500, body: { error: { type: "api_error" } }, times: 2 });
    clock.t += HOUR;
    const r = await e.handle({ action: "signal", runId: "q", actionId: "quote.customer_acceptance", value: "approve", userId: OWNER });
    expect(act(r.body, "stripe.send_invoice").status).toBe("failed");
    expect(act(r.body, "gmail.send_confirmation").status).not.toBe("applied");
    const again = await e.handle({ action: "resume", runId: "q" });
    expect(act(again.body, "stripe.send_invoice").status).toBe("applied");
    expect(act(again.body, "gmail.send_confirmation").status).toBe("applied");
    expect(w.state.stripe.invoices.filter((i) => i.metadata?.catering_quote === "CAT-2026-0142-r1")).toEqual([expect.objectContaining({ status: "open", amount_due: 57_500 })]);
  });

  it("a booked slot is declined (after the owner approves the no); large parties go to the owner", async () => {
    w.state.calendar.busy.push({ start: at(10), end: new Date(Date.parse(at(10)) + 3 * HOUR).toISOString() });
    const e = engine();
    const r = await e.handle({ action: "start", runId: "q", input: input(), requestedBy: user });
    expect(r.body.output).toMatchObject({ decision: "decline", reasons: ["date_unavailable"] });
    expect(act(r.body, "gmail.send_decline").status).toBe("pending_approval");
    expect(act(r.body, "gmail.send_quote")).toBeUndefined();
    await e.handle({ action: "decide", runId: "q", decision: "approve", userId: OWNER });
    expect(customerMails()[0]!.body).toMatch(/already booked for that time/);

    const big = await e.handle({ action: "start", runId: "big", input: input({ inquiryId: "CAT-2026-0200", event: { headcount: 220, start: at(20) } }), requestedBy: user });
    expect(big.body.phase).toBe("DONE");
    expect(big.body.output).toMatchObject({ decision: "manual", reasons: ["large_party"] });
    expect(w.state.gmail.sent.filter((m) => m.to === "tony@tonys-pizza.example")).toHaveLength(1);
    expect(customerMails()).toHaveLength(1);
  });

  it("a quote waiting for the customer survives a restart and books once", async () => {
    const store = new MemoryStore();
    await engine(store).handle({ action: "start", runId: "q", input: input(), requestedBy: user });
    await engine(store).handle({ action: "decide", runId: "q", decision: "approve", userId: OWNER });
    clock.t += HOUR;
    const r = await engine(store).handle({ action: "signal", runId: "q", actionId: "quote.customer_acceptance", value: "approve", userId: OWNER });
    expect(act(r.body, "stripe.send_invoice")).toMatchObject({ status: "applied", attempts: 1 });
    expect(w.state.calendar.events).toHaveLength(1);
  });

  it("an unanswered quote expires: nothing is booked", async () => {
    const e = engine();
    await e.handle({ action: "start", runId: "q", input: input(), requestedBy: user });
    await e.handle({ action: "decide", runId: "q", decision: "approve", userId: OWNER });
    clock.t += 7 * DAY + 1;
    await e.handle({ action: "tick" });
    const s = (await e.handle({ action: "status", runId: "q" })).body;
    expect(act(s, "quote.customer_acceptance").status).toBe("rejected");
    expect(act(s, "calendar.book_event").status).toBe("skipped");
    expect(s.phase).toBe("DONE");
  });
});
