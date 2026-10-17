import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { churnRiskSweep, scoreAccount } from "../src/workflows/churn-risk-sweep";
import { onboardingKickoff } from "../src/workflows/onboarding-kickoff";
import { reconcileLedgers, revenueReconciliation } from "../src/workflows/revenue-reconciliation";
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
    w.state.zendesk.tickets.push({ id: 4242, subject: "Dashboard down for our whole team", description: "We get a 503 error since 9am.", priority: "normal", tags: [] });
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

describe("revenue-reconciliation", () => {
  beforeEach(() => {
    addSub(w.state, "cus_alice", "price_pro_monthly", "active", 10);
    addSub(w.state, "cus_dev", "price_pro_monthly", "past_due", 2);
    w.state.hubspot.contacts.push({ id: "501", properties: { email: "dev@startupxyz.io", lifecyclestage: "customer" } });
    w.state.hubspot.contacts.push({ id: "502", properties: { email: "gone@oldco.com", lifecyclestage: "customer" } });
  });

  it("finds variances, posts the report, and gates CRM fixes", async () => {
    w.state.zendesk.tickets.push({ id: 9, subject: "Refund approved for ch_alice_1", tags: ["refund-approved"] });
    const e = w.engine(revenueReconciliation, { now: () => NOW });
    const { body } = await e.handle({ action: "start", runId: "close-2026-09", input: { financeChannel: "C0FINANCE1" }, requestedBy: user });
    expect(body.phase).toBe("AWAITING_APPROVAL");
    expect(body.output.totals).toMatchObject({ stripePaying: 2, crmCustomers: 2, matched: 1, crmMissing: 1, billingMissing: 1, pastDue: 1, refundsUnapproved: 0, refundsUnverified: 0, mrrMinor: 49000 + 9800 });
    expect(action(body, "slack.post_report").status).toBe("applied");
    expect(w.state.slack.messages[0].text).toMatch(/1 paying-but-not-in-CRM/);
    const fix = action(body, "hubspot.mark_customer");
    expect(fix).toMatchObject({ status: "pending_approval", summary: { email: "alice@acmecorp.com" } });

    const done = await e.handle({ action: "decide", runId: "close-2026-09", decision: "approve", userId: "U_CFO" });
    expect(action(done.body, "hubspot.mark_customer").status).toBe("applied");
    expect(w.state.hubspot.contacts.find((c) => c.properties.email === "alice@acmecorp.com")?.properties.lifecyclestage).toBe("customer");
    const rec = await e.handle({ action: "reconcile", runId: "close-2026-09" });
    expect(action(rec.body, "hubspot.mark_customer").reconcile.status).toBe("match");
  });

  it("without Zendesk, refunds are reported as unverified rather than approved", async () => {
    const e = w.engine(revenueReconciliation, { only: ["stripe", "hubspot", "slack"] });
    const { body } = await e.handle({ action: "start", runId: "close-nozd", input: { financeChannel: "C0FINANCE1" }, requestedBy: user });
    expect(body.output).toMatchObject({ refundsVerified: false, totals: { refundsUnverified: 1, refundsUnapproved: 0 } });
  });

  it("does not reconcile against a ledger it could not read", async () => {
    w.faults.push({ method: "POST", path: /contacts\/search$/, status: 403, body: { category: "MISSING_SCOPES" } });
    const e = w.engine(revenueReconciliation);
    const { body } = await e.handle({ action: "start", runId: "close-403", input: { financeChannel: "C0FINANCE1" }, requestedBy: user });
    expect(body.actions).toHaveLength(0);
    expect(body.output).toMatchObject({ reconciled: false });
    expect(w.state.slack.messages).toHaveLength(0);
  });

  it("flags refunds without an approval ticket", () => {
    const res = reconcileLedgers(
      { customers: [], refunds: [{ id: "re_x", charge: "ch_x", amountMinor: 100, currency: "usd" }], currency: "usd" },
      { customers: [] },
      { approvedRefundText: "ch_other", tickets: 1 },
    );
    expect(res.findings.map((f) => f.kind)).toEqual(["refund_unapproved"]);
  });
});

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

  it("refuses an inactive price: no Stripe writes at all", async () => {
    const e = w.engine(onboardingKickoff, { now: () => NOW });
    const { body } = await e.handle({ action: "start", runId: "hs-bad-price", input: deal({ plan: { priceId: "price_retired", quantity: 3 } }), requestedBy: user });
    expect(body.agents.find((a: any) => a.name === "billing-check")).toMatchObject({ status: "failed", errorCode: "fatal" });
    expect(body.actions.filter((a: any) => a.provider === "stripe")).toHaveLength(0);
    expect(w.state.stripe.customers.filter((c) => c.email === "hank@globex.test")).toHaveLength(0);
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
