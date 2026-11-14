import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/kit/store";
import { followUpEventId, followUpMessageId, followUpSlot, leadFollowUp, slackMarker } from "../src/workflows/lead-follow-up";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";
delete process.env.LEAD_EMAIL_CONFIRM_INTERVAL_MS;
delete process.env.LEAD_RETRY_INTERVAL_MS;

const MIN = 60_000;
const CHANNEL = "C0CSOPS001";
const user = { userId: "U_WEBFORM" };
const lead = (over: object = {}) => ({ leadId: "L-1001", name: "Ada Lovelace", email: "Ada@Example.test", salesChannel: CHANNEL, handoffUserId: "U0SALESLEAD", ...over });
const act = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const posts = (w: World, path: RegExp) => w.requests.filter((r) => r.method === "POST" && path.test(r.path)).length;

describe("lead-follow-up", () => {
  let w: World;
  let clock: { t: number };
  const engine = (store = new MemoryStore()) => w.engine(leadFollowUp, { now: () => clock.t, store });
  const status = async (e: ReturnType<typeof engine>, leadId = "L-1001") => (await e.handle({ action: "status", runId: `lead-${leadId}` })).body;
  const tickAt = async (e: ReturnType<typeof engine>, t: number) => {
    clock.t = t;
    await e.handle({ action: "tick" });
  };

  beforeEach(async () => {
    w = await startWorld();
    clock = { t: NOW };
  });
  afterEach(() => w.close());

  it("baseline: one contact, one associated deal, one confirmed email, then the event, then one completion post", async () => {
    const e = engine();
    const r = await e.handle({ action: "start", runId: "form-sub-1", input: lead(), requestedBy: user });
    expect(r.body).toMatchObject({ runId: "lead-L-1001", phase: "DONE", outcome: "ok", labels: { submissionId: "form-sub-1" } });
    expect(w.state.hubspot.contacts).toHaveLength(1);
    expect(w.state.hubspot.contacts[0].properties).toMatchObject({ email: "ada@example.test", firstname: "Ada", lastname: "Lovelace" });
    expect(w.state.hubspot.deals).toHaveLength(1);
    expect(w.state.hubspot.deals[0].properties.dealname).toBe("Lead L-1001 · Ada Lovelace");
    expect(w.state.hubspot.deals[0].associations.contacts.results[0].id).toBe(w.state.hubspot.contacts[0].id);
    expect(w.state.gmail.sent).toHaveLength(1);
    expect(w.state.gmail.sent[0]!.messageId).toBe(followUpMessageId("L-1001"));
    expect(w.state.gmail.sent[0]!.raw).toContain("To: ada@example.test");
    expect(w.state.calendar.events).toHaveLength(1);
    expect(w.state.calendar.events[0]).toMatchObject({ id: followUpEventId("L-1001"), sendUpdates: "none", start: { dateTime: followUpSlot(new Date(NOW)).start } });
    expect(w.state.calendar.events[0].attendees).toBeUndefined();
    expect(w.state.slack.messages).toHaveLength(1);
    expect(w.state.slack.messages[0].text).toContain(":white_check_mark: Lead followed up");
    expect(w.state.slack.messages[0].text).toContain(slackMarker("L-1001"));
    // The event is created only after the email send was answered.
    const order = w.requests.filter((q) => q.method === "POST").map((q) => q.path);
    expect(order.indexOf("/calendar/v3/calendars/primary/events")).toBeGreaterThan(order.indexOf("/gmail/v1/users/me/messages/send"));
    expect(act(r.body, "gmail.send_followup")).toMatchObject({ status: "applied", detail: { state: "confirmed", confirmedBy: "send response" }, detail_state: "confirmed", detail_confirmedBy: "send response" });
    const rec = (await e.handle({ action: "reconcile", runId: "lead-L-1001" })).body;
    expect(rec.actions.filter((a: any) => a.reconciled).map((a: any) => [a.id, a.reconciled])).toEqual([
      ["hubspot.contact", "match"],
      ["hubspot.deal", "match"],
      ["gmail.send_followup", "match"],
      ["calendar.followup_event", "match"],
      ["slack.notify_team", "match"],
    ]);
  });

  it("declares a tick schedule, so a deployed runtime wakes its re-checks and confirmation lookups", () => {
    expect(leadFollowUp.tickEvery).toBe("rate(1 minute)");
  });

  it("follow-up slot is the next business day (Friday → Monday)", () => {
    expect(followUpSlot(new Date("2026-10-16T09:00:00Z"))).toEqual({ start: "2026-10-19T16:00:00.000Z", end: "2026-10-19T16:30:00.000Z" });
  });

  it("an existing contact is adopted, not duplicated or overwritten", async () => {
    w.state.hubspot.contacts.push({ id: "77", properties: { email: "ada@example.test", firstname: "Augusta" }, archived: false });
    const r = await engine().handle({ action: "start", input: lead(), requestedBy: user });
    expect(act(r.body, "hubspot.contact")).toMatchObject({ ref: "77", detail: { created: false } });
    expect(w.state.hubspot.contacts).toHaveLength(1);
    expect(w.state.hubspot.contacts[0].properties.firstname).toBe("Augusta");
    expect(posts(w, /contacts$/)).toBe(0);
  });

  it("a contact created concurrently elsewhere (409 on create) is adopted", async () => {
    w.state.hubspot.contacts.push({ id: "88", properties: { email: "ada@example.test", firstname: "Ada" }, archived: false });
    w.faults.push({ method: "POST", path: /contacts\/search$/, status: 200, body: { total: 0, results: [] }, times: 1 });
    const r = await engine().handle({ action: "start", input: lead(), requestedBy: user });
    expect(act(r.body, "hubspot.contact")).toMatchObject({ status: "applied", ref: "88", detail: { verified: true } });
    expect(w.state.hubspot.contacts).toHaveLength(1);
  });

  it("a deal that does not read back as written is not reported as done (write_not_verified)", async () => {
    w.faults.push({ method: "GET", path: /^\/crm\/v3\/objects\/deals\/\d+$/, status: 200, body: { id: "1", properties: { dealname: "Something else" }, associations: {} } });
    const r = await engine().handle({ action: "start", input: lead(), requestedBy: user });
    expect(act(r.body, "hubspot.deal")).toMatchObject({ status: "failed", errorCode: "hubspot:write_not_verified" });
    expect(act(r.body, "gmail.send_followup").status).toBe("skipped");
    expect(w.state.gmail.sent).toHaveLength(0);
    expect(w.state.slack.messages[0].text).toContain("blocked at *HubSpot deal*");
  });

  it("resubmitting a lead (any submission id) joins the one run and writes nothing again", async () => {
    const e = engine();
    await e.handle({ action: "start", runId: "sub-a", input: lead(), requestedBy: user });
    const before = w.requests.length;
    const again = await e.handle({ action: "start", runId: "sub-b", input: lead({ name: "Ada K. Lovelace" }), requestedBy: user });
    expect(again.body).toMatchObject({ runId: "lead-L-1001", duplicate: true, duplicateStarts: 1 });
    expect(w.requests.length).toBe(before);
    expect([w.state.hubspot.deals.length, w.state.gmail.sent.length, w.state.calendar.events.length, w.state.slack.messages.length]).toEqual([1, 1, 1, 1]);
  });

  it("concurrent first submissions create one run and one of each effect", async () => {
    const e = engine();
    const replies = await Promise.all([1, 2, 3, 4, 5].map((i) => e.handle({ action: "start", runId: `sub-${i}`, input: lead(), requestedBy: user })));
    expect(new Set(replies.map((x) => x.body.runId))).toEqual(new Set(["lead-L-1001"]));
    expect(replies.filter((x) => x.body.duplicate === false)).toHaveLength(1);
    await e.idle();
    expect([w.state.hubspot.contacts.length, w.state.hubspot.deals.length, w.state.gmail.sent.length, w.state.calendar.events.length, w.state.slack.messages.length]).toEqual([1, 1, 1, 1, 1]);
  });

  it("deal accepted but response lost: read back by lead token, no second create", async () => {
    w.lostResponses.push({ method: "POST", path: /^\/crm\/v3\/objects\/deals$/, times: 1 });
    const r = await engine().handle({ action: "start", input: lead(), requestedBy: user });
    expect(act(r.body, "hubspot.deal")).toMatchObject({ status: "applied", detail: { created: true, via: "readback", associated: true, verified: true } });
    expect(w.state.hubspot.deals).toHaveLength(1);
    expect(posts(w, /^\/crm\/v3\/objects\/deals$/)).toBe(1);
    expect(r.body.outcome).toBe("ok");
  });

  it("email accepted but response lost: no resend; the first confirmation lookup (+10 min) confirms it, then the event is created", async () => {
    w.lostResponses.push({ method: "POST", path: /messages\/send$/, times: 1 });
    const e = engine();
    const r = await e.handle({ action: "start", input: lead(), requestedBy: user });
    expect(r.body.phase).toBe("WAITING");
    expect(act(r.body, "gmail.send_followup")).toMatchObject({ status: "scheduled", errorCode: "gmail:outcome_unknown", waitUntil: new Date(NOW + 10 * MIN).toISOString() });
    expect(act(r.body, "calendar.followup_event").status).toBe("scheduled");
    expect(w.state.calendar.events).toHaveLength(0);
    expect(w.state.slack.messages).toHaveLength(0);

    await tickAt(e, NOW + 5 * MIN); // not due yet
    expect(w.requests.filter((q) => q.method === "GET" && q.path === "/gmail/v1/users/me/messages").length).toBe(1); // only the pre-send lookup

    await tickAt(e, NOW + 10 * MIN);
    const s = await status(e);
    expect(act(s, "gmail.send_followup")).toMatchObject({ status: "applied", detail: { state: "confirmed", confirmedBy: "confirmation lookup 1/3", sendAttempts: 1 } });
    expect(posts(w, /messages\/send$/)).toBe(1);
    expect(w.state.gmail.sent).toHaveLength(1);
    expect(w.state.calendar.events).toHaveLength(1);
    expect(w.state.slack.messages[0].text).toContain("confirmed by confirmation lookup 1/3");
    expect(s).toMatchObject({ phase: "DONE", outcome: "ok" });
  });

  it("unresolved email: 3 lookups at +10/+20/+30 min, then a Slack handoff to a person; no resend, no event", async () => {
    w.lostResponses.push({ method: "POST", path: /messages\/send$/, times: 1 });
    // Every confirmation lookup fails (the pre-send lookup too).
    w.faults.push({ method: "GET", path: /^\/gmail\/v1\/users\/me\/messages$/, status: 503, body: { error: { code: 503, message: "backend error" } } });
    const e = engine();
    await e.handle({ action: "start", input: lead(), requestedBy: user });
    for (const [k, at] of [[1, 10], [2, 20]] as const) {
      await tickAt(e, NOW + at * MIN);
      const s = await status(e);
      expect(act(s, "gmail.send_followup")).toMatchObject({ status: "scheduled", errorCode: "gmail:delivery_unknown", waitUntil: new Date(NOW + (at + 10) * MIN).toISOString() });
      expect(act(s, "gmail.send_followup").error).toContain(`lookup ${k}/3`);
    }
    await tickAt(e, NOW + 30 * MIN);
    const s = await status(e);
    expect(act(s, "gmail.send_followup")).toMatchObject({ status: "failed", errorCode: "gmail:delivery_unconfirmed" });
    expect(act(s, "calendar.followup_event").status).toBe("skipped");
    expect(act(s, "slack.notify_team")).toMatchObject({ status: "applied", detail: { kind: "blocked", blockedStep: "gmail.send_followup" } });
    expect(s).toMatchObject({ phase: "DONE", outcome: "partial" });
    // 1 pre-send lookup + 3 confirmation lookups, one send, no event.
    expect(w.requests.filter((q) => q.method === "GET" && q.path === "/gmail/v1/users/me/messages").length).toBe(4);
    expect(posts(w, /messages\/send$/)).toBe(1);
    expect(w.state.calendar.events).toHaveLength(0);
    const text = w.state.slack.messages[0].text as string;
    expect(text).toContain("<@U0SALESLEAD>");
    expect(text).toContain("blocked at *follow-up email (Gmail)*");
    expect(text).toContain("Ada Lovelace &lt;ada@example.test&gt; (lead L-1001)");
    expect(text).toContain("MAY have been sent");
    expect(text).toContain(`rfc822msgid:${followUpMessageId("L-1001").replace("<", "&lt;").replace(">", "&gt;")}`);
    expect(text).toContain("Done: HubSpot contact");
    // Later lookups after the handoff do not happen on their own.
    await tickAt(e, NOW + 90 * MIN);
    expect(w.requests.filter((q) => q.method === "GET" && q.path === "/gmail/v1/users/me/messages").length).toBe(4);
  });

  it("a refused send is retried after a fresh lookup and succeeds once (rejected once)", async () => {
    w.faults.push({ method: "POST", path: /messages\/send$/, status: 403, body: { error: { code: 403, message: "rejected" } }, times: 1 });
    const e = engine();
    const r = await e.handle({ action: "start", input: lead(), requestedBy: user });
    expect(act(r.body, "gmail.send_followup")).toMatchObject({ status: "scheduled", errorCode: "gmail:403" });
    await tickAt(e, NOW + 2 * MIN);
    const s = await status(e);
    expect(act(s, "gmail.send_followup")).toMatchObject({ status: "applied", detail: { sendAttempts: 2 } });
    expect(w.state.gmail.sent).toHaveLength(1);
    expect(s.outcome).toBe("ok");
  });

  it("a send that keeps being refused hands off after 3 attempts: nothing sent, no event", async () => {
    w.faults.push({ method: "POST", path: /messages\/send$/, status: 403, body: { error: { code: 403, message: "rejected" } } });
    const e = engine();
    await e.handle({ action: "start", input: lead(), requestedBy: user });
    await tickAt(e, NOW + 2 * MIN);
    await tickAt(e, NOW + 4 * MIN);
    const s = await status(e);
    expect(act(s, "gmail.send_followup")).toMatchObject({ status: "failed", errorCode: "gmail:403" });
    expect(act(s, "calendar.followup_event").status).toBe("skipped");
    expect(w.state.gmail.sent).toHaveLength(0);
    expect(w.state.slack.messages[0].text).toContain("nothing was sent to the lead");
  });

  it("HubSpot auth failure blocks at the contact: no deal, no email, no event; Slack says so", async () => {
    w.faults.push({ method: "POST", path: /^\/crm\//, status: 401, body: { category: "INVALID_AUTHENTICATION" } });
    const r = await engine().handle({ action: "start", input: lead(), requestedBy: user });
    expect(act(r.body, "hubspot.contact")).toMatchObject({ status: "failed", errorCode: "hubspot:INVALID_AUTHENTICATION" });
    expect(["hubspot.deal", "gmail.send_followup", "calendar.followup_event"].map((id) => act(r.body, id).status)).toEqual(["skipped", "skipped", "skipped"]);
    expect(w.state.gmail.sent).toHaveLength(0);
    expect(w.state.slack.messages[0].text).toContain("blocked at *HubSpot contact*");
    expect(w.state.slack.messages[0].text).toContain("Nothing was emailed to the lead");
  });

  it("Calendar rate limited throughout: bounded re-checks, then blocked at the event with the email kept single", async () => {
    w.faults.push({ method: "POST", path: /\/calendar\/v3\/calendars\/[^/]+\/events$/, status: 429, body: { error: { code: 429 } } });
    const e = engine();
    await e.handle({ action: "start", input: lead(), requestedBy: user });
    await tickAt(e, NOW + 2 * MIN);
    await tickAt(e, NOW + 4 * MIN);
    const s = await status(e);
    expect(act(s, "calendar.followup_event")).toMatchObject({ status: "failed", errorCode: "calendar:429" });
    expect(posts(w, /\/events$/)).toBe(3);
    expect(w.state.gmail.sent).toHaveLength(1);
    expect(w.state.slack.messages[0].text).toContain("Only the calendar event is missing");
  });

  it("Slack post accepted but response lost: the marker is found in history, no second post", async () => {
    w.lostResponses.push({ method: "POST", path: /chat\.postMessage$/, times: 1 });
    const r = await engine().handle({ action: "start", input: lead(), requestedBy: user });
    expect(act(r.body, "slack.notify_team")).toMatchObject({ status: "applied", detail: { via: "readback" } });
    expect(w.state.slack.messages).toHaveLength(1);
  });

  it("Slack channel not found is a failed notification, never a silent success", async () => {
    const r = await engine().handle({ action: "start", input: lead({ salesChannel: "C0NOTHERE1" }), requestedBy: user });
    expect(act(r.body, "slack.notify_team")).toMatchObject({ status: "failed", errorCode: "slack:channel_not_found" });
    expect(r.body.outcome).toBe("partial");
  });

  it("a restart during the confirmation window continues from the saved state", async () => {
    w.lostResponses.push({ method: "POST", path: /messages\/send$/, times: 1 });
    const store = new MemoryStore();
    await engine(store).handle({ action: "start", input: lead(), requestedBy: user });
    const fresh = engine(store); // a new process over the same durable store
    await tickAt(fresh, NOW + 10 * MIN);
    const s = await status(fresh);
    expect(s).toMatchObject({ phase: "DONE", outcome: "ok" });
    expect(posts(w, /messages\/send$/)).toBe(1);
  });

  it("rejects invalid input without writing anything", async () => {
    const e = engine();
    for (const bad of [lead({ email: "not-an-email" }), lead({ leadId: "L 1/../x" }), lead({ name: "" }), lead({ salesChannel: "#sales" })]) {
      expect((await e.handle({ action: "start", input: bad, requestedBy: user })).status).toBe(400);
    }
    expect(w.requests).toHaveLength(0);
  });
});
