import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { onboardingKickoff } from "../src/workflows/onboarding-kickoff";
import { addSub, NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

let w: World;
beforeEach(async () => {
  w = await startWorld();
});
afterEach(() => w.close());

const user = { userId: "U_OPS" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id || a.id.startsWith(`${id}:`));

describe("onboarding-kickoff", () => {
  const deal = (over: object = {}) => ({
    dealId: "D-778",
    company: "Globex",
    contact: { email: "hank@globex.test", firstname: "Hank", lastname: "Scorpio" },
    plan: { priceId: "price_pro_monthly", quantity: 20 },
    onboardingChannel: "C0ONBOARD1",
    approvers: ["U_RVP"],
    ...over,
  });

  it("provisions CRM/Stripe/Zendesk, then subscribes and invites only after approval", async () => {
    const e = w.engine(onboardingKickoff, { now: () => NOW });
    const { body } = await e.handle({ action: "start", runId: "hs-D-778", input: deal(), requestedBy: user });
    expect(body.phase).toBe("AWAITING_APPROVAL");
    for (const id of ["hubspot.upsert_customer", "stripe.ensure_customer", "zendesk.provision_requester", "gmail.draft_welcome", "slack.post_handoff"]) {
      expect(action(body, id).status).toBe("applied");
    }
    expect(action(body, "stripe.create_subscription")).toMatchObject({ status: "pending_approval", summary: { amountPerPeriod: "$980.00" } });
    expect(w.state.stripe.subscriptions).toHaveLength(0);

    const done = await e.handle({ action: "decide", runId: "hs-D-778", decision: "approve", userId: "U_RVP" });
    expect(done.body.phase).toBe("DONE");
    const subs = w.state.stripe.subscriptions.filter((s) => s.customer === action(done.body, "stripe.ensure_customer").ref);
    expect(subs).toHaveLength(1);
    expect(subs[0].items.data[0].quantity).toBe(20);

    const rec = await e.handle({ action: "reconcile", runId: "hs-D-778" });
    for (const id of ["hubspot.upsert_customer", "stripe.ensure_customer", "stripe.create_subscription"]) expect(action(rec.body, id).reconcile.status).toBe("match");

    // Someone downgrades the seats by hand: reconcile reports drift.
    subs[0].items.data[0].quantity = 5;
    const drift = await e.handle({ action: "reconcile", runId: "hs-D-778" });
    expect(action(drift.body, "stripe.create_subscription").reconcile).toMatchObject({ status: "drift" });
  });

  it("a re-fired closed-won trigger never double-subscribes", async () => {
    const e = w.engine(onboardingKickoff, { now: () => NOW });
    await e.handle({ action: "start", runId: "hs-D-778-a", input: deal(), requestedBy: user });
    await e.handle({ action: "decide", runId: "hs-D-778-a", decision: "approve", userId: "U_RVP" });
    const { body } = await e.handle({ action: "start", runId: "hs-D-778-b", input: deal(), requestedBy: user });
    expect(body.output.alreadySubscribed).toBe(true);
    expect(action(body, "stripe.create_subscription")).toBeUndefined();
    expect(w.state.stripe.customers.filter((c) => c.email === "hank@globex.test")).toHaveLength(1);
    expect(w.state.stripe.subscriptions).toHaveLength(1);
  });

  it("a subscription still awaiting its first payment (incomplete) also blocks a duplicate", async () => {
    w.setNewSubscriptionStatus("incomplete");
    const e = w.engine(onboardingKickoff, { now: () => NOW });
    await e.handle({ action: "start", runId: "inc-a", input: deal(), requestedBy: user });
    await e.handle({ action: "decide", runId: "inc-a", decision: "approve", userId: "U_RVP" });
    expect(w.state.stripe.subscriptions.map((s) => s.status)).toEqual(["incomplete"]);
    const { body } = await e.handle({ action: "start", runId: "inc-b", input: deal(), requestedBy: user });
    expect(body.output.alreadySubscribed).toBe(true);
    expect(action(body, "stripe.create_subscription")).toBeUndefined();
  });

  it("approving two parked runs for the same deal creates one subscription", async () => {
    w.setNewSubscriptionStatus("incomplete");
    const e = w.engine(onboardingKickoff, { now: () => NOW });
    await e.handle({ action: "start", runId: "par-a", input: deal(), requestedBy: user });
    await e.handle({ action: "start", runId: "par-b", input: deal(), requestedBy: user });
    await e.handle({ action: "decide", runId: "par-a", decision: "approve", userId: "U_RVP" });
    const b = await e.handle({ action: "decide", runId: "par-b", decision: "approve", userId: "U_RVP" });
    expect(action(b.body, "stripe.create_subscription")).toMatchObject({ status: "applied", detail: { created: false } });
    expect(w.state.stripe.subscriptions).toHaveLength(1);
  });

  it("refuses an inactive price: no Stripe writes at all", async () => {
    const e = w.engine(onboardingKickoff, { now: () => NOW });
    const { body } = await e.handle({ action: "start", runId: "hs-bad-price", input: deal({ plan: { priceId: "price_retired", quantity: 3 } }), requestedBy: user });
    expect(body.agents.find((a: any) => a.name === "billing-check")).toMatchObject({ status: "failed", errorCode: "fatal" });
    expect(body.actions.filter((a: any) => a.provider === "stripe")).toHaveLength(0);
    expect(w.state.stripe.customers.filter((c) => c.email === "hank@globex.test")).toHaveLength(0);
  });
});
