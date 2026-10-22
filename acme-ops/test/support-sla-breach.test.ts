import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dueAt, supportSlaBreach } from "../src/workflows/support-sla-breach";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const MIN = 60_000;
const user = { userId: "U_SCHEDULER" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const input = (over: object = {}) => ({ sweepId: "SLA-2026-10-14T12-00", scopeTag: "brand_acme", supportChannel: "C0SUPPORT1", leadsChannel: "C0CSOPS001", pagerdutyServiceId: "PSUPP01", agentSlack: { "77": "U_AGENT_77" }, ...over });
const ticket = (id: number, minutesAgo: number, priority: string, tags: string[] = []) => ({ id, subject: `T${id}`, status: "open", priority, tags: ["brand_acme", ...tags], requester_id: 500 + id, assignee_id: 77, created_at: new Date(NOW - minutesAgo * MIN).toISOString(), updated_at: new Date(NOW).toISOString() });

describe("targets", () => {
  it("enterprise urgent is 15 minutes, standard low a day", () => {
    expect(dueAt({ tier: "enterprise", priority: "urgent", createdAt: new Date(NOW).toISOString() })).toBe(new Date(NOW + 15 * MIN).toISOString());
    expect(dueAt({ tier: "standard", priority: "low", createdAt: new Date(NOW).toISOString() }, 0.75)).toBe(new Date(NOW + 1080 * MIN).toISOString());
  });
});

describe("support-sla-breach runs", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
  });
  afterEach(() => w.close());

  it("warns at 75%, breaches at target and pages for enterprise; answered and out-of-scope tickets are left alone", async () => {
    w.state.zendesk.tickets.push(ticket(1, 0, "high", ["tier_enterprise"]), ticket(2, 0, "normal"), ticket(3, 0, "urgent"), { ...ticket(4, 0, "urgent"), tags: ["brand_other"] });
    w.state.zendesk.comments.push({ id: 9, ticketId: 3, public: true, author_id: 77, body: "On it" });
    const clock = { t: NOW };
    const e = w.engine(supportSlaBreach, { now: () => clock.t });
    const r = await e.handle({ action: "start", runId: "s", input: input(), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "timing", awaitingReply: 2, pastTarget: 0, enterprise: 1, truncated: false });
    clock.t = NOW + 45 * MIN + 1;
    await e.handle({ action: "tick" });
    expect(w.state.zendesk.tickets[0].tags).toContain("sla_warned");
    expect(w.state.slack.messages.at(-1).text).toMatch(/Ticket 1 \(enterprise, high\) .* <@U_AGENT_77>/);
    clock.t = NOW + 60 * MIN + 1;
    await e.handle({ action: "tick" });
    expect(w.state.zendesk.tickets[0].tags).toContain("sla_breached");
    expect(w.state.pagerduty.incidents).toEqual([expect.objectContaining({ incident_key: "zendesk-sla-1", urgency: "high", from: "ops-bot@acme.example" })]);
    // The standard ticket gets a reply before its warning.
    w.state.zendesk.comments.push({ id: 10, ticketId: 2, public: true, author_id: 77, body: "Hi" });
    clock.t = NOW + 480 * MIN + 1;
    await e.handle({ action: "tick" });
    const s = (await e.handle({ action: "status", runId: "s" })).body;
    expect(action(s, "sla.warn:2")).toMatchObject({ status: "skipped", detail: { reason: "agent replied" } });
    expect(action(s, "sla.breach:2")).toMatchObject({ status: "skipped" });
    expect(s.phase).toBe("DONE");
  });

  it("overlapping sweeps warn, breach and page once", async () => {
    w.state.zendesk.tickets.push(ticket(1, 0, "urgent", ["tier_enterprise"]));
    const clock = { t: NOW };
    const e = w.engine(supportSlaBreach, { now: () => clock.t });
    await e.handle({ action: "start", runId: "a", input: input(), requestedBy: user });
    await e.handle({ action: "start", runId: "b", input: input({ sweepId: "SLA-2026-10-14T12-05" }), requestedBy: user });
    clock.t = NOW + 16 * MIN;
    await e.handle({ action: "tick" });
    expect(w.state.slack.messages.filter((m: any) => /SLA breach: ticket 1/.test(m.text))).toHaveLength(1);
    expect(w.state.zendesk.comments.filter((c: any) => /SLA breached/.test(c.body))).toHaveLength(1);
    expect(w.state.pagerduty.incidents).toHaveLength(1);
  });

  it("a ticket already past target breaches at once; a pending ticket's clock is paused", async () => {
    w.state.zendesk.tickets.push(ticket(1, 600, "normal"), { ...ticket(2, 600, "normal"), status: "pending" });
    const r = await w.engine(supportSlaBreach, { now: () => NOW }).handle({ action: "start", runId: "s", input: input(), requestedBy: user });
    expect(r.body.output.pastTarget).toBe(1);
    expect(action(r.body, "sla.breach:1").status).toBe("applied");
    expect(action(r.body, "sla.warn:1")).toBeUndefined();
    expect(action(r.body, "sla.breach:2")).toBeUndefined();
  });

  it("when the queue can't be read, support is told timers aren't running", async () => {
    w.faults.push({ method: "GET", path: /^\/api\/v2\/tickets\.json$/, status: 503, body: {} });
    const r = await w.engine(supportSlaBreach, { now: () => NOW }).handle({ action: "start", runId: "s", input: input(), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "blocked" });
    expect(w.state.slack.messages[0].text).toMatch(/could not be read; SLA timers are not running/);
  });
});
