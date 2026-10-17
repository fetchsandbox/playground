import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { supportEscalation, triage } from "../src/workflows/support-escalation";
import { addSub, NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

let w: World;
beforeEach(async () => {
  w = await startWorld();
});
afterEach(() => w.close());

const user = { userId: "U_OPS" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id || a.id.startsWith(`${id}:`));

describe("support-escalation", () => {
  const ticketInput = (over: object = {}) => ({
    ticket: { id: 4242, subject: "Dashboard down for our whole team", description: "We get a 503 error since 9am.", requester: { email: "Alice@AcmeCorp.com", name: "Alice Johnson" } },
    escalationChannel: "C0SUPPORT1",
    approvers: ["U_LEAD"],
    ...over,
  });

  beforeEach(() => {
    addSub(w.state, "cus_alice", "price_pro_monthly", "active", 20);
    w.state.zendesk.tickets.push({ id: 4242, subject: "Dashboard down for our whole team", description: "We get a 503 error since 9am.", priority: "normal", tags: ["existing"], updated_at: "2026-10-14T12:00:00Z" });
  });

  it("triages, escalates, drafts, and parks the public reply for approval", async () => {
    const e = w.engine(supportEscalation, { now: () => NOW });
    const { status, body } = await e.handle({ action: "start", runId: "zd-4242-1", input: ticketInput(), requestedBy: user }, { "x-flow-run-id": "flow-1" });
    expect(status).toBe(200);
    expect(body.phase).toBe("AWAITING_APPROVAL");
    expect(body.output).toMatchObject({ severity: "urgent", category: "outage", escalated: true, ticketSource: "zendesk" });
    for (const id of ["zendesk.annotate_ticket", "slack.post_escalation", "calendar.hold_callback", "gmail.draft_reply"]) expect(action(body, id).status).toBe("applied");
    expect(action(body, "zendesk.public_reply").status).toBe("pending_approval");
    expect(w.state.zendesk.comments).toEqual([expect.objectContaining({ public: false })]);
    expect(w.state.zendesk.tickets[0].tags).toContain("existing");
    // The callback hold is internal: no attendees, no invitations.
    expect(w.state.calendar.events[0]).toMatchObject({ sendUpdates: "none" });
    expect(w.state.calendar.events[0].attendees).toBeUndefined();
    // Correlation header reaches every provider call of the run.
    expect(w.requests.length).toBeGreaterThan(5);
    expect(w.requests.every((r) => r.headers["x-flow-run-id"] === "flow-1")).toBe(true);

    const forbidden = await e.handle({ action: "decide", runId: "zd-4242-1", decision: "approve", userId: "U_RANDOM" });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.result).toBe("forbidden");

    const ok = await e.handle({ action: "decide", runId: "zd-4242-1", decision: "approve", userId: "U_LEAD" });
    expect(ok.body).toMatchObject({ result: "recorded", phase: "DONE", outcome: "ok" });
    expect(action(ok.body, "zendesk.public_reply").status).toBe("applied");
    expect(w.state.zendesk.comments.filter((c) => c.public)).toHaveLength(1);

    const again = await e.handle({ action: "decide", runId: "zd-4242-1", decision: "approve", userId: "U_LEAD" });
    expect(again.body.result).toBe("already_decided");
    expect(w.state.zendesk.comments.filter((c) => c.public)).toHaveLength(1);

    const rec = await e.handle({ action: "reconcile", runId: "zd-4242-1" });
    expect(action(rec.body, "zendesk.annotate_ticket").reconcile.status).toBe("match");
    expect(action(rec.body, "calendar.hold_callback").reconcile.status).toBe("match");
    expect(action(rec.body, "slack.post_escalation").reconcile.status).toBe("unverifiable");
  });

  it("works from the trigger payload when Zendesk isn't connected, and says so", async () => {
    const e = w.engine(supportEscalation, { only: ["stripe", "hubspot", "gmail", "calendar", "slack"], now: () => NOW });
    const { body } = await e.handle({ action: "start", runId: "zd-nozd", input: ticketInput(), requestedBy: user });
    expect(body.output.ticketSource).toBe("trigger_payload");
    expect(action(body, "zendesk.annotate_ticket")).toMatchObject({ status: "skipped", errorCode: "not_configured" });
    expect(action(body, "slack.post_escalation").status).toBe("applied");
  });

  it("a Slack refusal fails only that action; the run is partial, not lost", async () => {
    const e = w.engine(supportEscalation, { now: () => NOW });
    const { body } = await e.handle({ action: "start", runId: "zd-badchan", input: ticketInput({ escalationChannel: "C0NOTREAL1" }), requestedBy: user });
    expect(action(body, "slack.post_escalation")).toMatchObject({ status: "failed", errorCode: "slack:channel_not_found" });
    expect(action(body, "gmail.draft_reply").status).toBe("applied");
    expect(body.outcome).toBe("partial");
  });

  it("an agent's provider outage is isolated (Stripe 401 → billing agent failed, rest continue)", async () => {
    w.faults.push({ method: "GET", path: /^\/v1\/customers$/, status: 401, body: { error: { code: "api_key_invalid" } } });
    const e = w.engine(supportEscalation, { now: () => NOW });
    const { body } = await e.handle({ action: "start", runId: "zd-stripe401", input: ticketInput(), requestedBy: user });
    expect(body.agents.find((a: any) => a.name === "billing-health")).toMatchObject({ status: "failed", errorCode: "stripe:api_key_invalid" });
    expect(body.output.escalated).toBe(true);
    expect(body.outcome).toBe("partial");
  });

  it("duplicate and concurrent starts create one run and one Slack post", async () => {
    const e = w.engine(supportEscalation, { now: () => NOW });
    const replies = await Promise.all(Array.from({ length: 5 }, () => e.handle({ action: "start", runId: "zd-dup", input: ticketInput(), requestedBy: user })));
    await e.idle();
    expect(replies.filter((r) => r.body.duplicate === false)).toHaveLength(1);
    expect(w.state.slack.messages).toHaveLength(1);
    const st = await e.handle({ action: "status", runId: "zd-dup" });
    expect(st.body.duplicateStarts).toBe(4);
  });

  it("reject leaves the ticket without a public reply", async () => {
    const e = w.engine(supportEscalation, { now: () => NOW });
    await e.handle({ action: "start", runId: "zd-rej", input: ticketInput(), requestedBy: user });
    const { body } = await e.handle({ action: "decide", runId: "zd-rej", decision: "reject", userId: "U_LEAD" });
    expect(body.phase).toBe("REJECTED");
    expect(action(body, "zendesk.public_reply").status).toBe("rejected");
    expect(w.state.zendesk.comments.filter((c) => c.public)).toHaveLength(0);
  });

  it("rejects invalid input with readable issues", async () => {
    const e = w.engine(supportEscalation);
    const { status, body } = await e.handle({ action: "start", input: { ticket: { id: "x" } }, requestedBy: user });
    expect(status).toBe(400);
    expect((body.issues as string[]).join(" ")).toMatch(/escalationChannel/);
  });

  it("triage rules", () => {
    expect(triage("Possible data breach", "", []).severity).toBe("urgent");
    expect(triage("Question about invoice", "", []).category).toBe("billing");
    expect(triage("How do I export?", "", []).severity).toBe("low");
    expect(triage("How do I export?", "", [], "high").severity).toBe("high");
  });
});
