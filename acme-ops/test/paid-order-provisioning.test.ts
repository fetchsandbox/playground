import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../src/kit/log";
import { createAgentServer } from "../src/kit/server";
import { signStripePayload, verifyStripeSignature } from "../src/kit/webhooks";
import type { Engine } from "../src/kit/engine";
import { orderRunId, paidOrderProvisioning, POLICY, verdictFor, type Order } from "../src/workflows/paid-order-provisioning";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const SECRET = "whsec_test_secret";
const user = { userId: "U_SALES" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);

describe("stripe signature", () => {
  const raw = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded" });
  const now = 1_800_000_000;
  it("accepts a valid signature inside the tolerance", () => {
    expect(verifyStripeSignature(raw, signStripePayload(raw, SECRET, now), SECRET, now + 10)).toEqual({ ok: true });
  });
  it("refuses a mutated body, a wrong secret, an old timestamp and a missing header", () => {
    const sig = signStripePayload(raw, SECRET, now);
    expect(verifyStripeSignature(raw.replace("evt_1", "evt_2"), sig, SECRET, now)).toMatchObject({ ok: false, code: "bad_signature" });
    expect(verifyStripeSignature(raw, signStripePayload(raw, "whsec_other", now), SECRET, now)).toMatchObject({ ok: false, code: "bad_signature" });
    expect(verifyStripeSignature(raw, sig, SECRET, now + 301)).toMatchObject({ ok: false, code: "timestamp_outside_tolerance" });
    expect(verifyStripeSignature(raw, undefined, SECRET, now)).toMatchObject({ ok: false, code: "missing_signature" });
    expect(verifyStripeSignature(raw, "v1=abc", SECRET, now)).toMatchObject({ ok: false, code: "malformed_signature" });
  });
});

describe("provisioning verdict", () => {
  const o = (over: Partial<Order> = {}): Order => ({
    orderId: "ORD-1",
    paymentIntent: "pi_1",
    customerId: "cus_1",
    email: "a@x.io",
    plan: "team",
    seats: 3,
    organizationId: "org_acme",
    amountMinor: 6_000,
    currency: "usd",
    paidAt: null,
    status: "succeeded",
    refundedMinor: 0,
    disputed: false,
    provisionedBy: null,
    claim: null,
    ...over,
  });
  it("provisions only a payment that is succeeded, full, unrefunded and undisputed", () => {
    expect(verdictFor(o(), "r", NOW)).toMatchObject({ provision: true, review: false });
    expect(verdictFor(o({ status: "processing" }), "r", NOW)).toMatchObject({ provision: false });
    expect(verdictFor(o({ amountMinor: 5_999 }), "r", NOW)).toMatchObject({ provision: false, reason: expect.stringContaining("price is") });
    expect(verdictFor(o({ refundedMinor: 1 }), "r", NOW)).toMatchObject({ provision: false });
    expect(verdictFor(o({ disputed: true }), "r", NOW)).toMatchObject({ provision: false });
    expect(verdictFor(o({ provisionedBy: "order-ORD-1" }), "r", NOW)).toMatchObject({ provision: false, already: true });
    expect(verdictFor(o({ seats: POLICY.reviewSeatsAbove + 1, amountMinor: 2_000 * (POLICY.reviewSeatsAbove + 1) }), "r", NOW)).toMatchObject({ provision: true, review: true });
  });
  it("respects another run's fresh claim but takes over a stale one", () => {
    expect(verdictFor(o({ claim: { run: "other", at: NOW - 60_000 } }), "r", NOW)).toMatchObject({ provision: false });
    expect(verdictFor(o({ claim: { run: "other", at: NOW - 16 * 60_000 } }), "r", NOW)).toMatchObject({ provision: true });
    expect(verdictFor(o({ claim: { run: "r", at: NOW } }), "r", NOW)).toMatchObject({ provision: true });
  });
});

describe("paid-order-provisioning runs", () => {
  let w: World;
  let e: Engine<any>;
  let base: string;
  let close: () => Promise<void>;

  const checkout = (over: object = {}) => ({
    stage: "checkout",
    orderId: "ORD-2026-1001",
    customer: { email: "alice@acmecorp.com" },
    plan: "team",
    seats: 3,
    organizationId: "org_acme",
    paymentMethod: "pm_card_visa",
    opsChannel: "C0SUPPORT1",
    approvers: ["U_SALES_LEAD"],
    ...over,
  });
  const event = (pi: string, id = "evt_1", type = "payment_intent.succeeded") => JSON.stringify({ id, object: "event", type, livemode: false, data: { object: { id: pi, object: "payment_intent" } } });
  const deliver = async (raw: string, sig = signStripePayload(raw, SECRET, Math.floor(Date.now() / 1000))) => {
    const res = await fetch(`${base}/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": sig, "content-type": "application/json" }, body: raw });
    return { status: res.status, body: (await res.json()) as any };
  };
  const charge = async (over: object = {}, runId = "co-1") => {
    const r = await e.handle({ action: "start", runId, input: checkout(over), requestedBy: user, labels: { fs_case: "c1" } });
    return { r, pi: action(r.body, "stripe.charge_order")?.ref as string };
  };

  beforeEach(async () => {
    w = await startWorld();
    e = w.engine(paidOrderProvisioning, { now: () => Date.now() });
    const server = createAgentServer(e as Engine<unknown>, silentLogger, { stripeWebhookSecret: SECRET });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((r) => server.close(() => r()));
  });
  afterEach(async () => {
    await close();
    await w.close();
  });

  it("checkout charges once; the signed event provisions access, CRM, welcome draft and the ledger", async () => {
    const { r, pi } = await charge();
    expect(r.body).toMatchObject({ phase: "DONE", output: { amountMinor: 6_000, needsApproval: false } });
    expect(w.state.stripe.paymentIntents).toHaveLength(1);
    expect(w.state.stripe.paymentIntents[0].metadata).toMatchObject({ acme_order: "ORD-2026-1001", acme_seats: "3", acme_order_run: "co-1" });

    const d = await deliver(event(pi));
    expect(d).toMatchObject({ status: 200, body: { received: true, runId: orderRunId("ORD-2026-1001"), duplicate: false, phase: "DONE" } });
    const run = (await e.handle({ action: "status", runId: orderRunId("ORD-2026-1001") })).body;
    // The provisioning run carries the order's labels, so it is observable with the checkout.
    expect(run.labels).toMatchObject({ fs_case: "c1", trigger: "stripe_webhook" });
    for (const k of ["stripe.claim_order", "workos.grant_access", "hubspot.mark_customer", "gmail.draft_welcome", "stripe.record_provisioned"]) expect(action(run, `${k}:ORD-2026-1001`).status).toBe("applied");
    expect(w.state.workos.users).toEqual([expect.objectContaining({ email: "alice@acmecorp.com" })]);
    expect(w.state.workos.memberships).toEqual([expect.objectContaining({ organization_id: "org_acme", role: { slug: "member" } })]);
    expect(w.state.hubspot.contacts[0].properties).toMatchObject({ email: "alice@acmecorp.com", lifecyclestage: "customer" });
    expect(w.state.gmail.drafts).toHaveLength(1);
    expect(w.state.stripe.paymentIntents[0].metadata).toMatchObject({ acme_provisioned: orderRunId("ORD-2026-1001") });

    const rec = await e.handle({ action: "reconcile", runId: orderRunId("ORD-2026-1001") });
    expect(action(rec.body, "workos.grant_access:ORD-2026-1001").reconcile.status).toBe("match");
    expect(action(rec.body, "stripe.record_provisioned:ORD-2026-1001").reconcile.status).toBe("match");

    // Re-running checkout for the same order never charges twice.
    const again = await charge({}, "co-2");
    expect(again.r.body.output.alreadyCharged).toBe(true);
    expect(w.state.stripe.paymentIntents).toHaveLength(1);
  });

  it("redelivered, replayed and concurrent deliveries grant access once", async () => {
    const { pi } = await charge();
    const raw = event(pi, "evt_dup");
    const all = await Promise.all([1, 2, 3, 4].map(() => deliver(raw)));
    expect(all.every((x) => x.status === 200)).toBe(true);
    expect(all.filter((x) => !x.body.duplicate)).toHaveLength(1);
    await e.idle();
    // A different event id for the same payment (Stripe can send both) is the same order run too.
    const other = await deliver(event(pi, "evt_other"));
    expect(other.body.duplicate).toBe(true);
    expect(w.state.workos.memberships).toHaveLength(1);
    expect(w.state.gmail.drafts).toHaveLength(1);
  });

  it("refuses unsigned, mutated, wrongly signed and old events before touching anything", async () => {
    const { pi } = await charge();
    const raw = event(pi);
    const now = Math.floor(Date.now() / 1000);
    expect((await deliver(raw, "")).status).toBe(400);
    expect((await deliver(raw.replace("evt_1", "evt_9"), signStripePayload(raw, SECRET, now))).body).toMatchObject({ code: "bad_signature" });
    expect((await deliver(raw, signStripePayload(raw, "whsec_attacker", now))).body).toMatchObject({ code: "bad_signature" });
    expect((await deliver(raw, signStripePayload(raw, SECRET, now - 3_600))).body).toMatchObject({ code: "timestamp_outside_tolerance" });
    expect(w.state.workos.users).toHaveLength(0);
    expect((await e.handle({ action: "status", runId: orderRunId("ORD-2026-1001") })).status).toBe(404);
  });

  it("a validly signed event for a refunded (stale) or underpaid payment grants nothing", async () => {
    const { pi } = await charge();
    w.state.stripe.refunds.push({ id: "re_x", amount: 6_000, payment_intent: pi, status: "succeeded" });
    const d = await deliver(event(pi));
    expect(d.status).toBe(200);
    const run = (await e.handle({ action: "status", runId: orderRunId("ORD-2026-1001") })).body;
    expect(run.output.refused).toEqual([{ orderId: "ORD-2026-1001", reason: expect.stringContaining("refunded") }]);
    expect(run.actions.map((a: any) => a.kind)).toEqual(["slack.post_order"]);
    expect(w.state.workos.users).toHaveLength(0);

    // A payment whose metadata claims more seats than were paid for.
    w.state.stripe.paymentIntents.push({ id: "pi_forged", customer: "cus_alice", amount: 2_000, amount_received: 2_000, currency: "usd", status: "succeeded", latest_charge: "ch_f", created: Math.floor(Date.now() / 1000), metadata: { acme_order: "ORD-FORGED-1", acme_plan: "team", acme_seats: "50", acme_org: "org_acme", acme_ops_channel: "C0SUPPORT1" } });
    await deliver(event("pi_forged", "evt_f"));
    const forged = (await e.handle({ action: "status", runId: orderRunId("ORD-FORGED-1") })).body;
    expect(forged.output.refused[0].reason).toContain("price is");
    expect(w.state.workos.users).toHaveLength(0);
  });

  it("ignores events that are not an ACME order payment, and unknown payments", async () => {
    w.state.stripe.paymentIntents.push({ id: "pi_shop", customer: "cus_alice", amount: 100, currency: "usd", status: "succeeded", metadata: {} });
    expect((await deliver(event("pi_shop"))).body).toMatchObject({ received: true, ignored: true });
    expect((await deliver(event("pi_unknown"))).body).toMatchObject({ received: true, ignored: true });
    expect((await deliver(event("pi_shop", "evt_c", "charge.refunded"))).body).toMatchObject({ ignored: true });
  });

  it("the same request forwarded through AgentCore /invocations provisions identically", async () => {
    const { pi } = await charge();
    const raw = event(pi);
    const res = await fetch(`${base}/invocations`, {
      method: "POST",
      body: JSON.stringify({ method: "POST", path: "/webhooks/stripe", headers: { "Stripe-Signature": signStripePayload(raw, SECRET, Math.floor(Date.now() / 1000)) }, raw_body: raw }),
    });
    const env = (await res.json()) as any;
    expect(env.status).toBe(200);
    expect(JSON.parse(Buffer.from(env.body, "base64").toString())).toMatchObject({ received: true, runId: orderRunId("ORD-2026-1001") });
    expect(w.state.workos.memberships).toHaveLength(1);
  });

  it("the sweep provisions a paid order whose event never arrived, and a late event then changes nothing", async () => {
    const { pi } = await charge();
    const s = await e.handle({ action: "start", runId: "sweep-1", input: { stage: "sweep", customers: ["alice@acmecorp.com"], minAgeMinutes: 0, opsChannel: "C0SUPPORT1" }, requestedBy: user });
    expect(s.body.output.provisioned).toEqual(["ORD-2026-1001"]);
    expect(w.state.workos.memberships).toHaveLength(1);
    const late = await deliver(event(pi));
    expect(late.status).toBe(200);
    const run = (await e.handle({ action: "status", runId: orderRunId("ORD-2026-1001") })).body;
    expect(run.output.alreadyProvisioned).toEqual(["ORD-2026-1001"]);
    expect(w.state.workos.memberships).toHaveLength(1);
    // A second sweep finds nothing left.
    const s2 = await e.handle({ action: "start", runId: "sweep-2", input: { stage: "sweep", customers: ["alice@acmecorp.com"], minAgeMinutes: 0, opsChannel: "C0SUPPORT1" }, requestedBy: user });
    expect(s2.body.output.orders).toBe(0);
    // The default age guard leaves a just-paid order to its webhook.
    await charge({ orderId: "ORD-2026-1002" }, "co-3");
    const s3 = await e.handle({ action: "start", runId: "sweep-3", input: { stage: "sweep", customers: ["alice@acmecorp.com"], opsChannel: "C0SUPPORT1" }, requestedBy: user });
    expect(s3.body.output.orders).toBe(0);
  });

  it("large charges and large orders wait for approval", async () => {
    const big = await charge({ orderId: "ORD-2026-2000", plan: "business", seats: 250 }, "co-big");
    expect(big.r.body.phase).toBe("AWAITING_APPROVAL");
    expect(action(big.r.body, "stripe.charge_order")).toMatchObject({ gate: "approval", status: "pending_approval" });
    expect(w.state.stripe.paymentIntents).toHaveLength(0);
    expect((await e.handle({ action: "decide", runId: "co-big", decision: "approve", userId: "U_RANDOM" })).status).toBe(403);
    const ok = await e.handle({ action: "decide", runId: "co-big", decision: "approve", userId: "U_SALES_LEAD" });
    const pi = action(ok.body, "stripe.charge_order").ref;
    await deliver(event(pi));
    const run = (await e.handle({ action: "status", runId: orderRunId("ORD-2026-2000") })).body;
    expect(run.phase).toBe("AWAITING_APPROVAL");
    expect(action(run, "workos.grant_access:ORD-2026-2000").status).toBe("pending_approval");
    expect(w.state.workos.memberships).toHaveLength(0);
  });

  it("without a signing secret, events are refused", async () => {
    const server = createAgentServer(e as Engine<unknown>, silentLogger, {});
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/stripe`, { method: "POST", body: event("pi_x"), headers: { "stripe-signature": "t=1,v1=00" } });
    expect(res.status).toBe(503);
    await new Promise<void>((r) => server.close(() => r()));
  });
});
