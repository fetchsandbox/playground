import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { visaAndLeaveExpiry } from "../src/workflows/visa-and-leave-expiry";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const DAY = 86_400_000;
const user = { userId: "U_NOTION_WEBHOOK" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const PAGE = "0f5c3b2a9d8e4f7a8b6c5d4e3f2a1b0c";
const input = (over: object = {}) => ({ eventId: "evt_notion_0001", pageId: PAGE, hrChannel: "C0ONBOARD1", hrCalendarId: "hr@acme.example", ...over });
const date = (days: number) => new Date(NOW + days * DAY).toISOString().slice(0, 10);
const row = (type: string, d: string, extra: object = {}) => ({ id: PAGE, last_edited_time: new Date(NOW).toISOString(), properties: { Employee: { title: [{ plain_text: "Priya Rao" }] }, Email: { email: "priya@acme.example" }, "Manager email": { email: "lee@acme.example" }, Type: { select: { name: type } }, Document: { select: { name: "H-1B" } }, Date: { date: { start: d } }, Status: { select: { name: "active" } }, ...extra } });

describe("visa-and-leave-expiry runs", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
  });
  afterEach(() => w.close());

  it("work authorization: notices, counsel case at 90 days, reverification escalation at expiry", async () => {
    w.state.notion.pages.push(row("work_authorization", date(120)));
    const clock = { t: NOW };
    const e = w.engine(visaAndLeaveExpiry, { now: () => clock.t });
    const r = await e.handle({ action: "start", runId: "v", input: input(), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "work_authorization", date: date(120), status: "active" });
    expect(action(r.body, "hr.auth_notice:180")).toBeUndefined();
    clock.t = NOW + 30 * DAY + 4 * 3_600_000;
    await e.handle({ action: "tick" });
    expect(w.state.asana.tasks[0]).toMatchObject({ name: `Renewal: Priya Rao — H-1B expires ${date(120)}`, due_on: date(90) });
    expect(w.state.slack.messages.at(-1).text).toMatch(/expires .* \(90 days\)\. Immigration counsel/);
    clock.t = NOW + 120 * DAY + 4 * 3_600_000;
    await e.handle({ action: "tick" });
    expect(w.state.notion.pages[0].properties.Status).toEqual({ select: { name: "reverification_overdue" } });
    expect(w.state.slack.messages.at(-1).text).toMatch(/I-9 must be reverified/);
  });

  it("a renewal recorded in the register stands every remaining timer down", async () => {
    w.state.notion.pages.push(row("work_authorization", date(100)));
    const clock = { t: NOW };
    const e = w.engine(visaAndLeaveExpiry, { now: () => clock.t });
    await e.handle({ action: "start", runId: "v", input: input(), requestedBy: user });
    w.state.notion.pages[0].properties.Date = { date: { start: date(1200) } };
    w.state.notion.pages[0].properties.Status = { select: { name: "renewed" } };
    clock.t = NOW + 101 * DAY;
    await e.handle({ action: "tick" });
    const s = (await e.handle({ action: "status", runId: "v" })).body;
    expect(s.actions.every((a: any) => a.status === "skipped")).toBe(true);
    expect(w.state.asana.tasks).toHaveLength(0);
    // The edit's own run schedules the new date.
    const again = await e.handle({ action: "start", runId: "v2", input: input({ eventId: "evt_notion_0002" }), requestedBy: user });
    expect(again.body.actions).toEqual([]);
  });

  it("leave: return planning and manager meeting 14 days before, extension check the day after", async () => {
    w.state.notion.pages.push(row("leave", date(20)));
    const clock = { t: NOW };
    const e = w.engine(visaAndLeaveExpiry, { now: () => clock.t });
    await e.handle({ action: "start", runId: "v", input: input(), requestedBy: user });
    clock.t = NOW + 6 * DAY + 4 * 3_600_000;
    await e.handle({ action: "tick" });
    expect(w.state.gmail.drafts).toHaveLength(1);
    expect(w.state.calendar.events[0]).toMatchObject({ summary: "Welcome back: Priya Rao", attendees: [{ email: "priya@acme.example" }, { email: "lee@acme.example" }], sendUpdates: "all" });
    clock.t = NOW + 21 * DAY + 4 * 3_600_000;
    await e.handle({ action: "tick" });
    expect(w.state.slack.messages.at(-1).text).toMatch(/was due back from leave .* Check for an extension/);
  });

  it("an unrelated row is ignored; an unreadable row is reported", async () => {
    w.state.notion.pages.push(row("equipment", date(10)));
    const r = await w.engine(visaAndLeaveExpiry, { now: () => NOW }).handle({ action: "start", runId: "v", input: input(), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "ignored" });
    const b = await w.engine(visaAndLeaveExpiry, { now: () => NOW }).handle({ action: "start", runId: "v2", input: input({ pageId: "ffffffffffffffffffffffffffffffff" }), requestedBy: user });
    expect(b.body.output).toEqual({ mode: "blocked" });
  });
});
