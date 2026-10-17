import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { churnRiskSweep, scoreAccount } from "../src/workflows/churn-risk-sweep";
import { addSub, NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

let w: World;
beforeEach(async () => {
  w = await startWorld();
});
afterEach(() => w.close());

const user = { userId: "U_OPS" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id || a.id.startsWith(`${id}:`));

describe("churn-risk-sweep", () => {
  it("scores accounts, drafts check-ins and gates QBR invites", async () => {
    addSub(w.state, "cus_alice", "price_pro_monthly", "active", 5);
    addSub(w.state, "cus_dev", "price_pro_monthly", "past_due", 1);
    w.state.gmail.messages.push({ from: "alice@acmecorp.com" });
    w.state.hubspot.contacts.push({ id: "601", properties: { email: "alice@acmecorp.com", lifecyclestage: "customer" } });
    const e = w.engine(churnRiskSweep, { now: () => NOW });
    const { body } = await e.handle({
      action: "start",
      runId: "sweep-w42",
      input: { accounts: [{ email: "alice@acmecorp.com", name: "Alice" }, { email: "dev@startupxyz.io", name: "Dev" }], csChannel: "C0CSOPS001" },
      requestedBy: user,
    });
    expect(body.output).toMatchObject({ high: 1, low: 1 });
    const dev = (body.output.scores as any[]).find((s) => s.email === "dev@startupxyz.io");
    expect(dev).toMatchObject({ tier: "high", score: 40 + 10 + 10 + 10 });
    expect(action(body, "slack.post_digest").status).toBe("applied");
    expect(action(body, "gmail.draft_checkin").status).toBe("applied");
    expect(action(body, "calendar.book_qbr")).toMatchObject({ status: "pending_approval", summary: { attendee: "dev@startupxyz.io" } });
    const done = await e.handle({ action: "decide", runId: "sweep-w42", decision: "approve", userId: "U_CS" });
    expect(done.body.phase).toBe("DONE");
    expect(w.state.calendar.events[0]).toMatchObject({ sendUpdates: "all", attendees: [{ email: "dev@startupxyz.io" }] });
  });

  it("missing signals are reported as unknown, not as healthy", () => {
    const s = scoreAccount("x@y.com", undefined, undefined, undefined, undefined);
    expect(s).toMatchObject({ score: 0, tier: "low", unknown: ["billing", "crm", "support", "inbox"] });
  });
});

describe("churn-risk-sweep canceled accounts", () => {
  it("an account whose only subscription was canceled scores high", async () => {
    addSub(w.state, "cus_alice", "price_pro_monthly", "canceled", 5);
    const e = w.engine(churnRiskSweep, { now: () => NOW });
    const { body } = await e.handle({ action: "start", runId: "sweep-canceled", input: { accounts: [{ email: "alice@acmecorp.com" }], csChannel: "C0CSOPS001" }, requestedBy: user });
    expect(body.output.scores[0]).toMatchObject({ tier: "high", reasons: expect.arrayContaining(["+50 subscription canceled"]) });
  });
});
