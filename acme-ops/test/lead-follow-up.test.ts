import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leadFollowUp } from "../src/workflows/lead-follow-up";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";
process.env.LEAD_FOLLOWUP_CONFIRM_WINDOW_MS = "0";

let w: World;
beforeEach(async () => {
  w = await startWorld();
});
afterEach(() => w.close());

const user = { userId: "U_OPS" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id || a.id.startsWith(`${id}:`));

const lead = (over: object = {}) => ({
  leadId: "L-1001",
  name: "Alex Buyer",
  email: "alex@example.test",
  salesChannel: "C0SALES0001",
  calendarId: "primary",
  confirmWindowMs: 0,
  ...over,
});

describe("lead-follow-up", () => {
  it("upserts contact, creates one Deal, sends email, books calendar and notifies Slack", async () => {
    const e = w.engine(leadFollowUp, { now: () => NOW });
    const { body } = await e.handle({ action: "start", runId: "lf-baseline", input: lead(), requestedBy: user });
    expect(body.phase).toBe("DONE");
    for (const id of ["hubspot.upsert_contact", "hubspot.create_deal", "gmail.send_followup", "calendar.create_followup", "slack.notify_complete"]) {
      expect(action(body, id).status).toBe("applied");
    }
    expect(action(body, "slack.handoff_blocked").status).toBe("skipped");
    expect(w.state.hubspot.deals).toHaveLength(1);
    expect(w.state.hubspot.deals[0].properties.dealname).toBe("Lead follow-up L-1001");
    expect(w.state.gmail.messages).toHaveLength(1);
    expect(w.state.calendar.events).toHaveLength(1);
  });

  it("a re-fired lead adopts the existing Deal and Message-ID instead of duplicating", async () => {
    const e = w.engine(leadFollowUp, { now: () => NOW });
    await e.handle({ action: "start", runId: "lf-a", input: lead(), requestedBy: user });
    const { body } = await e.handle({ action: "start", runId: "lf-b", input: lead(), requestedBy: user });
    expect(action(body, "hubspot.create_deal")).toMatchObject({ status: "applied", detail: { created: false } });
    expect(action(body, "gmail.send_followup")).toMatchObject({ status: "applied", detail: { created: false, confirmed: true } });
    expect(w.state.hubspot.deals).toHaveLength(1);
    expect(w.state.gmail.messages).toHaveLength(1);
    expect(w.state.calendar.events).toHaveLength(1);
  });

  it("duplicate start of the same runId applies each effect once", async () => {
    const e = w.engine(leadFollowUp, { now: () => NOW });
    await e.handle({ action: "start", runId: "lf-dup", input: lead(), requestedBy: user });
    const { body } = await e.handle({ action: "start", runId: "lf-dup", input: lead(), requestedBy: user });
    expect(action(body, "hubspot.create_deal").attempts).toBe(1);
    expect(action(body, "gmail.send_followup").attempts).toBe(1);
    expect(w.state.gmail.messages).toHaveLength(1);
  });

  it("lost send response is recovered by Message-ID lookup without a second send", async () => {
    w.state.gmail.loseSendResponses = 1;
    const e = w.engine(leadFollowUp, { now: () => NOW });
    const { body } = await e.handle({ action: "start", runId: "lf-lost", input: lead({ leadId: "L-lost" }), requestedBy: user });
    expect(action(body, "gmail.send_followup")).toMatchObject({ status: "applied", detail: { confirmed: true, recovered: true } });
    expect(w.state.gmail.messages).toHaveLength(1);
    expect(action(body, "calendar.create_followup").status).toBe("applied");
  });

  it("unknown send with empty mailbox parks unconfirmed, withholds calendar, and hands off after lookups", async () => {
    w.state.gmail.loseSendAndDrop = true;
    const e = w.engine(leadFollowUp, { now: () => NOW });
    const { body } = await e.handle({ action: "start", runId: "lf-unknown", input: lead({ leadId: "L-unk" }), requestedBy: user });
    expect(action(body, "gmail.send_followup")).toMatchObject({ status: "applied", detail: { confirmed: false, outcome: "unknown" } });
    expect(w.state.gmail.messages).toHaveLength(0);
    expect(action(body, "calendar.create_followup").status).toBe("skipped");
    expect(action(body, "slack.handoff_blocked").status).toBe("applied");
    expect(w.state.slack.messages.some((m) => m.text.includes("Message-ID") && m.text.includes("blind retry"))).toBe(true);
  });

  it("unresolved email after confirmation lookups withholds calendar and hands off with instructions", async () => {
    w.state.gmail.rejectSend = true;
    const e = w.engine(leadFollowUp, { now: () => NOW });
    const { body } = await e.handle({ action: "start", runId: "lf-reject", input: lead({ leadId: "L-rej" }), requestedBy: user });
    expect(action(body, "hubspot.create_deal").status).toBe("applied");
    expect(action(body, "gmail.send_followup").status).toBe("failed");
    expect(action(body, "calendar.create_followup").status).toBe("skipped");
    expect(w.state.calendar.events).toHaveLength(0);
    expect(action(body, "slack.handoff_blocked").status).toBe("applied");
    expect(w.state.slack.messages.some((m) => m.text.includes("blocked") && m.text.includes("L-rej"))).toBe(true);
  });

  it("HubSpot outage notifies the blocked step and creates nothing", async () => {
    w.faults.push({ method: "POST", path: /\/crm\/v3\/objects\/contacts\/search/, status: 401, body: { category: "UNAUTHORIZED" } });
    const e = w.engine(leadFollowUp, { now: () => NOW });
    const { body } = await e.handle({ action: "start", runId: "lf-hs", input: lead({ leadId: "L-hs" }), requestedBy: user });
    expect(body.agents.find((a: any) => a.name === "crm-check")).toMatchObject({ status: "failed" });
    expect(action(body, "hubspot.upsert_contact")).toBeUndefined();
    expect(action(body, "slack.notify_blocked_step").status).toBe("applied");
    expect(w.state.hubspot.deals).toHaveLength(0);
  });

  it("invalid email is rejected before agents run", async () => {
    const e = w.engine(leadFollowUp, { now: () => NOW });
    const res = await e.handle({ action: "start", runId: "lf-bad", input: lead({ email: "nope" }), requestedBy: user });
    expect(res.status).toBe(400);
  });

  it("reconcile matches contact and deal", async () => {
    const e = w.engine(leadFollowUp, { now: () => NOW });
    await e.handle({ action: "start", runId: "lf-rec", input: lead({ leadId: "L-rec" }), requestedBy: user });
    const rec = await e.handle({ action: "reconcile", runId: "lf-rec" });
    expect(action(rec.body, "hubspot.upsert_contact").reconcile.status).toBe("match");
    expect(action(rec.body, "hubspot.create_deal").reconcile.status).toBe("match");
    expect(action(rec.body, "gmail.send_followup").reconcile.status).toBe("match");
  });
});
