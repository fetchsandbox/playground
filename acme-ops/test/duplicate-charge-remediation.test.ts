import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { duplicateChargeRemediation, findDuplicates, gateRefunds, POLICY, type Charge, type Duplicate } from "../src/workflows/duplicate-charge-remediation";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const MIN = 60_000;
const user = { userId: "U_BILLING" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const kind = (body: any, k: string) => body.actions.filter((a: any) => a.kind === k);

describe("duplicate detection and limits", () => {
  const c = (id: string, at: number, ref = "in_1", amount = 4900): Charge => ({ paymentIntent: id, charge: `ch_${id}`, amountMinor: amount, refundedMinor: 0, currency: "usd", createdMs: NOW + at * MIN, reference: ref });

  it("pairs a second charge for the same reference within the window with the first", () => {
    const { duplicates, ambiguous } = findDuplicates([c("b", 2), c("a", 0), c("c", 40), c("d", 3, "in_2"), c("e", 4, "in_1", 9900)]);
    expect(duplicates.map((d) => [d.charge.paymentIntent, d.original.paymentIntent])).toEqual([["b", "a"]]);
    expect(ambiguous).toEqual([]);
  });

  it("never treats same-amount payments without a reference as duplicates", () => {
    const { duplicates, ambiguous } = findDuplicates([c("a", 0, ""), c("b", 1, "")]);
    expect(duplicates).toEqual([]);
    expect(ambiguous.map((x) => x.paymentIntent)).toEqual(["b"]);
  });

  const d = (id: string, amount: number, at = 0): Duplicate => ({ email: "a@x.io", customerId: "cus_a", paymentIntent: id, charge: null, original: "o", amountMinor: amount, currency: "usd", createdMs: NOW + at });

  it("refunds automatically up to the single and batch limits, then asks for approval", () => {
    const g = gateRefunds([d("big", POLICY.autoRefundMaxMinor + 1, 0), d("a", 40_000, 1), d("b", 40_000, 2), d("c", 40_000, 3), d("e", 40_000, 4), d("f", 40_000, 5), d("g", 10_000, 6)]);
    expect(g.mode).toBe("refund");
    expect(g.refunds.map((r) => [r.paymentIntent, r.gate])).toEqual([["big", "approval"], ["a", "auto"], ["b", "auto"], ["c", "auto"], ["e", "auto"], ["f", "auto"], ["g", "approval"]]);
  });

  it("halts beyond the automation ceiling", () => {
    expect(gateRefunds(Array.from({ length: POLICY.hardMaxRefunds + 1 }, (_, i) => d(`p${i}`, 100, i))).mode).toBe("halted");
    expect(gateRefunds([d("x", POLICY.hardMaxTotalMinor + 1)])).toMatchObject({ mode: "halted", refunds: [] });
  });
});

describe("duplicate-charge-remediation runs", () => {
  let w: World;
  const input = (over: object = {}) => ({
    incidentId: "INC-2026-1014",
    description: "Payment retry job ran twice between 11:00 and 12:00 UTC.",
    window: { from: new Date(NOW - 60 * MIN).toISOString(), to: new Date(NOW + 60 * MIN).toISOString() },
    customers: ["alice@acmecorp.com", "dev@startupxyz.io", "nobody@example.com"],
    financeChannel: "C0FINANCE1",
    approvers: ["U_CONTROLLER"],
    ...over,
  });
  let n = 0;
  const pay = (customer: string, at: number, amount = 4900, ref: Record<string, string> = { invoice: "in_oct" }) => {
    const p = { id: `pi_${++n}`, customer, amount, amount_received: amount, currency: "usd", status: "succeeded", latest_charge: `ch_${n}`, created: Math.floor((NOW + at * MIN) / 1000), metadata: ref };
    w.state.stripe.paymentIntents.push(p);
    return p;
  };

  beforeEach(async () => {
    w = await startWorld();
    n = 0;
  });
  afterEach(() => w.close());

  it("refunds each duplicate once, drafts one notice per customer, records and posts the remediation", async () => {
    const a1 = pay("cus_alice", 0);
    const a2 = pay("cus_alice", 1);
    const d1 = pay("cus_dev", 5, 9900, { invoice: "in_dev" });
    const d2 = pay("cus_dev", 6, 9900, { invoice: "in_dev" });
    pay("cus_dev", 7, 1500, { invoice: "in_other" }); // a different purchase
    pay("cus_alice", -600); // outside the window
    const e = w.engine(duplicateChargeRemediation, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "INC-2026-1014", input: input(), requestedBy: user });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ phase: "DONE", outcome: "ok" });
    expect(r.body.output).toMatchObject({ mode: "refund", refunds: 2, refundMinor: 14_800, autoMinor: 14_800, approvalMinor: 0, notFound: 1 });
    expect(action(r.body, `stripe.refund_duplicate:${a2.id}`).status).toBe("applied");
    expect(action(r.body, `stripe.refund_duplicate:${d2.id}`).status).toBe("applied");
    expect(w.state.stripe.refunds.filter((x) => x.payment_intent).map((x) => [x.payment_intent, x.amount, x.metadata.acme_duplicate_of])).toEqual([
      [a2.id, 4900, a1.id],
      [d2.id, 9900, d1.id],
    ]);
    expect(kind(r.body, "gmail.draft_notice")).toHaveLength(2);
    expect(w.state.gmail.drafts).toHaveLength(2);
    expect(w.state.asana.tasks[0].name).toContain("INC-2026-1014");
    expect(w.state.slack.messages[0].text).toContain("2 duplicate charge(s)");

    // A second run of the same incident (e.g. re-triggered after a fix) refunds nothing new.
    const again = await e.handle({ action: "start", runId: "INC-2026-1014-rerun", input: input(), requestedBy: user });
    expect(again.body.output).toMatchObject({ mode: "nothing" });
    expect(w.state.stripe.refunds.filter((x) => x.payment_intent)).toHaveLength(2);

    const rec = await e.handle({ action: "reconcile", runId: "INC-2026-1014" });
    expect(action(rec.body, `stripe.refund_duplicate:${a2.id}`).reconcile.status).toBe("match");
  });

  it("parks large refunds for approval and drafts that customer's notice only after approval", async () => {
    pay("cus_alice", 0, 120_000);
    const dup = pay("cus_alice", 2, 120_000);
    pay("cus_dev", 0);
    pay("cus_dev", 1);
    const e = w.engine(duplicateChargeRemediation, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "inc", input: input(), requestedBy: user });
    expect(r.body.phase).toBe("AWAITING_APPROVAL");
    expect(action(r.body, `stripe.refund_duplicate:${dup.id}`)).toMatchObject({ gate: "approval", status: "pending_approval" });
    expect(kind(r.body, "gmail.draft_notice").map((a: any) => a.status).sort()).toEqual(["applied", "pending_approval"]);
    expect(w.state.stripe.refunds.filter((x) => x.payment_intent)).toHaveLength(1);
    expect((await e.handle({ action: "decide", runId: "inc", decision: "approve", userId: "U_INTERN" })).status).toBe(403);
    const ok = await e.handle({ action: "decide", runId: "inc", decision: "approve", userId: "U_CONTROLLER" });
    expect(ok.body.phase).toBe("DONE");
    expect(w.state.stripe.refunds.filter((x) => x.payment_intent === dup.id)).toEqual([expect.objectContaining({ amount: 120_000 })]);
    expect(w.state.gmail.drafts).toHaveLength(2);
  });

  it("excludes disputed charges and fails closed when disputes can't be read", async () => {
    pay("cus_alice", 0);
    const dup = pay("cus_alice", 1);
    w.state.stripe.disputes.push({ id: "dp_1", charge: dup.latest_charge, status: "needs_response" });
    const e = w.engine(duplicateChargeRemediation, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "inc", input: input(), requestedBy: user });
    expect(r.body.output).toMatchObject({ mode: "nothing", excluded: 1 });
    expect(kind(r.body, "stripe.refund_duplicate")).toHaveLength(0);

    w.state.stripe.disputes.length = 0;
    w.faults.push({ method: "GET", path: /^\/v1\/disputes$/, status: 500, body: { error: { code: "api_error" } } });
    const r2 = await e.handle({ action: "start", runId: "inc-2", input: input(), requestedBy: user });
    expect(r2.body.agents.find((a: any) => a.name === "dispute-check").status).toBe("failed");
    expect(r2.body.output).toMatchObject({ mode: "blocked", reason: expect.stringContaining("dispute status unknown") });
    expect(kind(r2.body, "stripe.refund_duplicate")).toHaveLength(0);
    expect(action(r2.body, "slack.post_digest").status).toBe("applied");
  });

  it("leaves same-amount payments without a reference to a person", async () => {
    pay("cus_alice", 0, 4900, {});
    pay("cus_alice", 1, 4900, {});
    const e = w.engine(duplicateChargeRemediation, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "inc", input: input(), requestedBy: user });
    expect(r.body.output).toMatchObject({ mode: "nothing", ambiguous: 1 });
    expect(w.state.stripe.refunds.filter((x) => x.payment_intent)).toHaveLength(0);
  });

  it("refuses at write time when a duplicate was refunded by hand after the scan", async () => {
    pay("cus_alice", 0);
    const dup = pay("cus_alice", 1);
    const e = w.engine(duplicateChargeRemediation, { now: () => NOW });
    // Someone refunds it in the dashboard between the scan and the refund.
    w.faults.push({ method: "GET", path: new RegExp(`^/v1/payment_intents/${dup.id}$`), status: 200, body: { ...dup, amount_received: 0 }, times: 1 });
    const r = await e.handle({ action: "start", runId: "inc", input: input(), requestedBy: user });
    expect(action(r.body, `stripe.refund_duplicate:${dup.id}`)).toMatchObject({ status: "failed", errorCode: "fatal" });
    expect(kind(r.body, "gmail.draft_notice")[0]).toMatchObject({ status: "failed", errorCode: "fatal" });
    expect(w.state.gmail.drafts).toHaveLength(0);
  });

  it("concurrent deliveries of one incident refund once", async () => {
    pay("cus_alice", 0);
    const dup = pay("cus_alice", 1);
    const e = w.engine(duplicateChargeRemediation, { now: () => NOW });
    await Promise.all([1, 2, 3, 4].map(() => e.handle({ action: "start", runId: "inc", input: input(), requestedBy: user })));
    await e.idle();
    expect(w.state.stripe.refunds.filter((x) => x.payment_intent === dup.id)).toHaveLength(1);
  });

  it("without a window, scans the 72 hours before the run", async () => {
    pay("cus_alice", -70 * 60);
    const dup = pay("cus_alice", -70 * 60 + 2);
    pay("cus_dev", -80 * 60);
    pay("cus_dev", -80 * 60 + 2); // older than 72 hours: out of scope
    const e = w.engine(duplicateChargeRemediation, { now: () => NOW });
    const { window: _omit, ...noWindow } = input();
    const r = await e.handle({ action: "start", runId: "inc", input: noWindow, requestedBy: user });
    expect(r.body.output).toMatchObject({ mode: "refund", refunds: 1 });
    expect(action(r.body, `stripe.refund_duplicate:${dup.id}`).status).toBe("applied");
    expect(w.state.asana.tasks[0].notes).toContain("default: 72h before the run");
  });

  it("rejects a window longer than the policy allows", async () => {
    const e = w.engine(duplicateChargeRemediation, { now: () => NOW });
    const r = await e.handle({ action: "start", input: input({ window: { from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z" } }), requestedBy: user });
    expect(r.status).toBe(400);
    expect(w.requests).toHaveLength(0);
  });
});
