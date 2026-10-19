import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/kit/store";
import { cancellationVerdict, parseChoice, POLICY, productCancellation, productTerms, refundOffer } from "../src/workflows/product-cancellation";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const DAY = 86_400_000;
const user = { userId: "U_OPS" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const terms = productTerms();

describe("product-cancellation policy", () => {
  it("reads product terms from Stripe metadata, defaulting to self-serve with every method", () => {
    expect(terms).toEqual({ cancellation: "self_serve", minTermMonths: 0, refundable: true, methods: ["original_payment", "store_credit", "gift_card"] });
    expect(productTerms({ acme_cancellation: "contract" }).minTermMonths).toBe(POLICY.defaultMinTermMonths);
    expect(productTerms({ acme_cancellation: "contract", acme_min_term_months: "6", acme_refund_methods: "store_credit, bogus", acme_refundable: "true" })).toEqual({
      cancellation: "contract",
      minTermMonths: 6,
      refundable: true,
      methods: ["store_credit"],
    });
  });

  it("cancels in policy, asks for an exception inside a commitment or when the start is unknown", () => {
    const contract = productTerms({ acme_cancellation: "contract", acme_min_term_months: "12" });
    expect(cancellationVerdict({ status: "active" }, terms, NOW).kind).toBe("cancel");
    expect(cancellationVerdict({ status: "active", startedAt: NOW - 100 * DAY }, contract, NOW)).toMatchObject({ kind: "exception", reason: expect.stringContaining("12-month commitment") });
    expect(cancellationVerdict({ status: "active", startedAt: NOW - 400 * DAY }, contract, NOW).kind).toBe("cancel");
    expect(cancellationVerdict({ status: "active" }, contract, NOW).kind).toBe("exception");
    expect(cancellationVerdict({ status: "active" }, productTerms({ acme_cancellation: "not_cancellable" }), NOW).kind).toBe("exception");
    expect(cancellationVerdict({ status: "canceled" }, terms, NOW).kind).toBe("already");
    expect(cancellationVerdict({ status: "paused" }, terms, NOW).kind).toBe("refused");
  });

  const pay = (daysAgo: number, amount = 4900, refunded = 0) => ({ paymentIntent: "pi_1", amountMinor: amount, refundedMinor: refunded, currency: "usd", paidAt: NOW - daysAgo * DAY, refundable: true });
  const gift = { available: true, currency: "USD" };

  it("refunds in full inside the money-back window, to any method", () => {
    expect(refundOffer(pay(10), "month", terms, NOW, gift)).toMatchObject({ tier: "full", amountMinor: 4900, methods: ["original_payment", "store_credit", "gift_card"] });
    expect(refundOffer(pay(10, 4900, 900), "month", terms, NOW, gift).amountMinor).toBe(4000);
    expect(refundOffer(pay(10), "month", terms, NOW, { available: false }).methods).toEqual(["original_payment", "store_credit"]);
    expect(refundOffer(pay(10), "month", terms, NOW, { available: true, currency: "EUR" }).methods).not.toContain("gift_card");
    expect(refundOffer({ ...pay(10), refundable: false }, "month", terms, NOW, gift).methods).toEqual(["store_credit", "gift_card"]);
  });

  it("offers only credit for the unused share after 30 days, and nothing after 90", () => {
    expect(refundOffer(pay(73, 36500), "year", terms, NOW, gift)).toMatchObject({ tier: "prorated_credit", amountMinor: 29200, methods: ["store_credit", "gift_card"] });
    expect(refundOffer(pay(45), "month", terms, NOW, gift).tier).toBe("none");
    expect(refundOffer(pay(120, 36500), "year", terms, NOW, gift)).toMatchObject({ tier: "none", reason: expect.stringContaining("90-day") });
    expect(refundOffer(pay(5, 4900, 4900), "month", terms, NOW, gift)).toMatchObject({ tier: "none", reason: "last payment already refunded" });
    expect(refundOffer(undefined, "month", terms, NOW, gift).tier).toBe("none");
    expect(refundOffer(pay(5), "month", productTerms({ acme_refundable: "false" }), NOW, gift).tier).toBe("none");
  });

  it("reads the customer's choice, refusing ambiguous answers", () => {
    expect(parseChoice("1")).toBe("original_payment");
    expect(parseChoice("Please put it back on my credit card")).toBe("original_payment");
    expect(parseChoice("2 please")).toBe("store_credit");
    expect(parseChoice("Store credit is fine")).toBe("store_credit");
    expect(parseChoice("Option 3 - the gift card")).toBe("gift_card");
    expect(parseChoice("giftcard!")).toBe("gift_card");
    expect(parseChoice("1 or 2, whatever")).toBeUndefined();
    expect(parseChoice("thanks")).toBeUndefined();
  });
});

describe("product-cancellation runs", () => {
  let w: World;
  const TICKET = 4242;
  const REQUESTER = 777;

  function seed(opts: { id?: string; email?: string; interval?: "month" | "year"; amount?: number; paidDaysAgo?: number; productMeta?: Record<string, string>; startedDaysAgo?: number } = {}) {
    const key = opts.id ?? "alice";
    const email = opts.email ?? "alice@acmecorp.com";
    let cus = w.state.stripe.customers.find((c) => c.email === email);
    if (!cus) w.state.stripe.customers.push((cus = { id: `cus_${key}`, email, name: key }));
    const amount = opts.amount ?? 4900;
    const product = { id: `prod_${key}`, name: opts.productMeta?.acme_cancellation === "contract" ? "Monitoring Contract" : "Pro Plan", active: true, metadata: opts.productMeta ?? {} };
    w.state.stripe.products.push(product);
    const price = { id: `price_${key}`, active: true, currency: "usd", unit_amount: amount, product: product.id, recurring: { interval: opts.interval ?? "month" } };
    const sub = { id: `sub_${key}`, customer: cus.id, status: "active", items: { data: [{ price, quantity: 1 }] }, metadata: {} as Record<string, string>, start_date: Math.floor((NOW - (opts.startedDaysAgo ?? 400) * DAY) / 1000) };
    w.state.stripe.subscriptions.push(sub);
    w.state.stripe.paymentIntents.push({
      id: `pi_${key}`,
      customer: cus.id,
      amount,
      amount_received: amount,
      currency: "usd",
      status: "succeeded",
      latest_charge: `ch_${key}`,
      created: Math.floor((NOW - (opts.paidDaysAgo ?? 5) * DAY) / 1000),
      metadata: { subscription_id: sub.id },
    });
    return { cus, sub };
  }

  const request = (over: object = {}) => ({
    stage: "request",
    channel: "email",
    customer: { email: "Alice@AcmeCorp.com", name: "Alice Johnson" },
    ticketId: TICKET,
    message: "Please cancel my Pro plan, we moved to another tool.",
    opsChannel: "C0SUPPORT1",
    giftCardLocationId: "LOC_MAIN",
    approvers: ["U_CX_LEAD"],
    ...over,
  });
  const choice = (over: object = {}) => ({ stage: "refund_choice", customer: { email: "alice@acmecorp.com" }, ticketId: TICKET, opsChannel: "C0SUPPORT1", giftCardLocationId: "LOC_MAIN", approvers: ["U_FINANCE"], ...over });
  const comments = (pub?: boolean) => w.state.zendesk.comments.filter((c) => c.ticketId === TICKET && (pub === undefined || c.public === pub));
  const reply = (body: string, author = REQUESTER) => w.state.zendesk.comments.push({ id: Date.now(), ticketId: TICKET, body, public: true, author_id: author });

  beforeEach(async () => {
    w = await startWorld();
    w.state.zendesk.tickets.push({ id: TICKET, subject: "Cancel", status: "new", requester_id: REQUESTER, tags: ["web"], updated_at: "2026-10-14T00:00:00Z" });
  });
  afterEach(() => w.close());

  it("uses the supplied subscription owner and ticket's offer among duplicate-email customers", async () => {
    const { cus, sub } = seed();
    w.state.stripe.customers.unshift({ id: "cus_000_duplicate", email: cus.email, name: "Another record", metadata: {} });
    const e = w.engine(productCancellation, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "duplicate-email-owner", input: request({ subscriptionId: sub.id }), requestedBy: user });
    expect(r.body).toMatchObject({ phase: "DONE", outcome: "ok" });
    expect(sub.status).toBe("canceled");
    reply("1");
    const refund = await e.handle({ action: "start", runId: "duplicate-email-choice", input: choice(), requestedBy: user });
    expect(refund.body).toMatchObject({ phase: "DONE", outcome: "ok", output: { refundMethod: "original_payment" } });
  });
  it("accepts Slack and posts its case feed in the originating thread", async () => {
    const { sub } = seed();
    const e = w.engine(productCancellation, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "native-slack", input: request({ channel: "slack", subscriptionId: sub.id, opsThreadTs: "1792340000.000001" }), requestedBy: user });
    expect(r.body).toMatchObject({ phase: "DONE", outcome: "ok" });
    expect(comments(true)[0].body).toContain("from your Slack message");
    expect(w.state.slack.messages[0].thread_ts).toBe("1792340000.000001");
  });

  it("in policy: acknowledges, notes the research, cancels, offers every method, then refunds as store credit from the customer's reply", async () => {
    const { sub } = seed();
    const e = w.engine(productCancellation, { now: () => NOW });
    const r1 = await e.handle({ action: "start", runId: "zd-4242-request", input: request(), requestedBy: user });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ phase: "DONE", outcome: "ok" });
    for (const id of ["zendesk.acknowledge", "zendesk.policy_note", "stripe.cancel_subscription", "zendesk.refund_offer", "slack.post_case"]) expect(action(r1.body, id).status).toBe("applied");
    expect(action(r1.body, "stripe.cancel_subscription").gate).toBe("auto");
    expect(r1.body.output).toMatchObject({ decision: "cancel", subscriptionId: "sub_alice", refundOffer: { tier: "full", amountMinor: 4900, methods: ["original_payment", "store_credit", "gift_card"] } });

    expect(sub.status).toBe("canceled");
    expect(sub.metadata).toMatchObject({ acme_cxl_ticket: "4242", acme_cxl_requester: "777", acme_cxl_offer: "original_payment,store_credit,gift_card", acme_cxl_amount: "4900", acme_cxl_payment: "pi_alice", acme_cxl_policy: POLICY.version });
    expect(w.state.stripe.customers[0].metadata).toMatchObject({ acme_cxl_4242: "sub_alice" });
    const [ack, offer] = comments(true);
    expect(ack!.body).toContain("Here is what happens next");
    expect(offer!.body).toMatch(/1 - Refund to your original payment[\s\S]*2 - ACME store credit[\s\S]*3 - ACME digital gift card/);
    expect(comments(false)).toHaveLength(1);
    expect(comments(false)[0].body).toContain("Decision: cancel now");
    const ticket = w.state.zendesk.tickets[0];
    expect(ticket.status).toBe("pending");
    expect(ticket.tags).toEqual(expect.arrayContaining(["web", "cancellation", "cxl_acknowledged", "cxl_refund_offer"]));

    reply("2 please, store credit is fine");
    const r2 = await e.handle({ action: "start", runId: "zd-4242-reply-1", input: choice(), requestedBy: user });
    expect(r2.body).toMatchObject({ phase: "DONE", outcome: "ok" });
    expect(r2.body.output).toMatchObject({ stage: "refund_choice", refundMethod: "store_credit", refundMinor: 4900, needsApproval: false });
    expect(action(r2.body, "stripe.issue_store_credit").status).toBe("applied");
    expect(w.state.stripe.balanceTxns).toEqual([expect.objectContaining({ customer: "cus_alice", amount: -4900, metadata: expect.objectContaining({ acme_cxl_ticket: "4242" }) })]);
    expect(sub.metadata.acme_cxl_refund).toMatch(/^store_credit:cbtxn_/);
    expect(comments(true).at(-1)!.body).toContain("store credit");
    expect(ticket.status).toBe("solved");

    // A second reply (or a re-fired trigger) never pays twice.
    reply("actually 1");
    const r3 = await e.handle({ action: "start", runId: "zd-4242-reply-2", input: choice(), requestedBy: user });
    expect(r3.body.output).toMatchObject({ decision: "blocked", reason: expect.stringContaining("already refunded") });
    expect(w.state.stripe.balanceTxns).toHaveLength(1);
    expect(w.state.stripe.refunds.filter((r) => r.payment_intent === "pi_alice")).toHaveLength(0);

    const rec = await e.handle({ action: "reconcile", runId: "zd-4242-reply-1" });
    expect(action(rec.body, "stripe.issue_store_credit").reconcile.status).toBe("match");
    const rec1 = await e.handle({ action: "reconcile", runId: "zd-4242-request" });
    expect(action(rec1.body, "stripe.cancel_subscription").reconcile.status).toBe("match");
    expect(action(rec1.body, "zendesk.refund_offer").reconcile.status).toBe("match");
  });

  it("refunds to the original payment when the ticket field says so, and reconciles the refund", async () => {
    seed();
    const e = w.engine(productCancellation, { now: () => NOW });
    await e.handle({ action: "start", runId: "req", input: request(), requestedBy: user });
    const r = await e.handle({ action: "start", runId: "choice", input: choice({ choice: "original_payment" }), requestedBy: user });
    expect(action(r.body, "stripe.refund_original_payment").status).toBe("applied");
    expect(w.state.stripe.refunds.filter((x) => x.payment_intent === "pi_alice")).toEqual([expect.objectContaining({ amount: 4900, metadata: expect.objectContaining({ acme_cxl_ticket: "4242" }) })]);
    const rec = await e.handle({ action: "reconcile", runId: "choice" });
    expect(action(rec.body, "stripe.refund_original_payment").reconcile.status).toBe("match");
  });

  it("issues a Square gift card and sends its number to the customer only", async () => {
    seed();
    const e = w.engine(productCancellation, { now: () => NOW });
    await e.handle({ action: "start", runId: "req", input: request(), requestedBy: user });
    reply("Option 3 - the gift card");
    const r = await e.handle({ action: "start", runId: "choice", input: choice(), requestedBy: user });
    expect(r.body).toMatchObject({ phase: "DONE", outcome: "ok" });
    const card = w.state.square.giftCards[0];
    expect(card).toMatchObject({ state: "ACTIVE", balance_money: { amount: 4900, currency: "USD" } });
    expect(comments(true).at(-1)!.body).toContain(card.gan);
    expect(w.state.zendesk.tickets[0].status).toBe("solved");
    // The full number stays out of run state and Slack.
    expect(JSON.stringify(r.body)).not.toContain(card.gan);
    expect(w.state.slack.messages.some((m) => m.text.includes(card.gan))).toBe(false);
    const rec = await e.handle({ action: "reconcile", runId: "choice" });
    expect(action(rec.body, "square.issue_gift_card").reconcile.status).toBe("match");
  });

  it("asks again when the reply is unclear or names a method that was not offered", async () => {
    seed({ interval: "year", amount: 36500, paidDaysAgo: 60 });
    const e = w.engine(productCancellation, { now: () => NOW });
    const r1 = await e.handle({ action: "start", runId: "req", input: request(), requestedBy: user });
    expect(r1.body.output.refundOffer).toMatchObject({ tier: "prorated_credit", methods: ["store_credit", "gift_card"] });
    reply("1");
    const r2 = await e.handle({ action: "start", runId: "c1", input: choice(), requestedBy: user });
    expect(r2.body.output).toMatchObject({ decision: "clarify", reason: "original_payment was not offered" });
    expect(action(r2.body, "zendesk.clarify_choice").status).toBe("applied");
    expect(comments(true).at(-1)!.body).toMatch(/2 - ACME store credit[\s\S]*3 - ACME digital gift card/);
    expect(comments(true).at(-1)!.body).not.toContain("1 - ");
    reply("hmm not sure");
    const r3 = await e.handle({ action: "start", runId: "c2", input: choice(), requestedBy: user });
    expect(r3.body.output.decision).toBe("clarify");
    expect(w.state.stripe.balanceTxns).toHaveLength(0);
  });

  it("ignores replies from anyone but the requester", async () => {
    seed();
    const e = w.engine(productCancellation, { now: () => NOW });
    await e.handle({ action: "start", runId: "req", input: request(), requestedBy: user });
    reply("2", 555);
    const r = await e.handle({ action: "start", runId: "c", input: choice(), requestedBy: user });
    expect(r.body.output.decision).toBe("clarify");
    w.state.zendesk.tickets[0].requester_id = 555;
    const r2 = await e.handle({ action: "start", runId: "c2", input: choice({ choice: "store_credit" }), requestedBy: user });
    expect(r2.body.output).toMatchObject({ decision: "blocked", reason: expect.stringContaining("not the customer who cancelled") });
    expect(w.state.stripe.balanceTxns).toHaveLength(0);
  });

  it("outside the policy (inside a contract term) waits for approval; rejection cancels nothing", async () => {
    const { sub } = seed({ productMeta: { acme_cancellation: "contract", acme_min_term_months: "12" }, startedDaysAgo: 100 });
    const e = w.engine(productCancellation, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "req", input: request(), requestedBy: user });
    expect(r.body.phase).toBe("AWAITING_APPROVAL");
    expect(action(r.body, "stripe.cancel_subscription")).toMatchObject({ kind: "stripe.cancel_subscription_exception", status: "pending_approval" });
    expect(action(r.body, "zendesk.refund_offer").status).toBe("pending_approval");
    expect(action(r.body, "zendesk.acknowledge").status).toBe("applied");
    expect(w.state.slack.messages[0].text).toContain("Approval needed");
    expect(sub.status).toBe("active");

    expect((await e.handle({ action: "decide", runId: "req", decision: "approve", userId: "U_AGENT" })).status).toBe(403);
    const rej = await e.handle({ action: "decide", runId: "req", decision: "reject", userId: "U_CX_LEAD" });
    expect(rej.body.phase).toBe("REJECTED");
    expect(sub.status).toBe("active");
    expect(comments(true)).toHaveLength(1);
  });

  it("an approved exception cancels and sends the offer", async () => {
    const { sub } = seed({ productMeta: { acme_cancellation: "contract" }, startedDaysAgo: 100 });
    const e = w.engine(productCancellation, { now: () => NOW });
    await e.handle({ action: "start", runId: "req", input: request(), requestedBy: user });
    const ok = await e.handle({ action: "decide", runId: "req", decision: "approve", userId: "U_CX_LEAD" });
    expect(ok.body).toMatchObject({ phase: "DONE", result: "recorded" });
    expect(sub.status).toBe("canceled");
    expect(action(ok.body, "zendesk.refund_offer").status).toBe("applied");
  });

  it("confirms a cancellation with no refund due and solves the ticket", async () => {
    seed({ paidDaysAgo: 200 });
    const e = w.engine(productCancellation, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "req", input: request(), requestedBy: user });
    expect(r.body.output.refundOffer).toMatchObject({ tier: "none" });
    expect(action(r.body, "zendesk.cancellation_confirmed").status).toBe("applied");
    expect(action(r.body, "zendesk.refund_offer")).toBeUndefined();
    expect(w.state.zendesk.tickets[0].status).toBe("solved");
    const later = await e.handle({ action: "start", runId: "c", input: choice({ choice: "store_credit" }), requestedBy: user });
    expect(later.body.output).toMatchObject({ decision: "blocked", reason: "no refund was offered on this cancellation" });
  });

  it("refunds above the auto-refund limit wait for an approver", async () => {
    seed({ interval: "year", amount: 120_000, paidDaysAgo: 10 });
    const e = w.engine(productCancellation, { now: () => NOW });
    await e.handle({ action: "start", runId: "req", input: request(), requestedBy: user });
    const r = await e.handle({ action: "start", runId: "c", input: choice({ choice: "original_payment" }), requestedBy: user });
    expect(r.body.phase).toBe("AWAITING_APPROVAL");
    expect(action(r.body, "stripe.refund_original_payment").status).toBe("pending_approval");
    expect(action(r.body, "zendesk.refund_confirmation").status).toBe("pending_approval");
    const ok = await e.handle({ action: "decide", runId: "c", decision: "approve", userId: "U_FINANCE" });
    expect(ok.body.phase).toBe("DONE");
    expect(w.state.stripe.refunds.filter((x) => x.payment_intent === "pi_alice")).toEqual([expect.objectContaining({ amount: 120_000 })]);
  });

  it("a phone request without a ticket opens one, once, and works on it", async () => {
    seed();
    const e = w.engine(productCancellation, { now: () => NOW });
    const input = request({ channel: "phone", ticketId: undefined });
    const r = await e.handle({ action: "start", runId: "call-991", input, requestedBy: user });
    expect(r.body.phase).toBe("DONE");
    const created = action(r.body, "zendesk.create_ticket");
    expect(created.status).toBe("applied");
    const t = w.state.zendesk.tickets.find((x) => String(x.id) === created.ref)!;
    expect(t.tags).toEqual(expect.arrayContaining(["cancellation", "via_phone", "cxl_refund_offer"]));
    expect(w.state.zendesk.comments.filter((c) => c.ticketId === t.id && c.public)).toHaveLength(2);
    expect(w.state.stripe.customers[0].metadata).toMatchObject({ [`acme_cxl_${t.id}`]: "sub_alice" });
    const dup = await e.handle({ action: "start", runId: "call-991", input, requestedBy: user });
    expect(dup.body.duplicate).toBe(true);
    expect(w.state.zendesk.tickets).toHaveLength(2);
  });

  it("concurrent deliveries of one request cancel once and post each message once", async () => {
    seed();
    const e = w.engine(productCancellation, { now: () => NOW, store: new MemoryStore() });
    const all = await Promise.all([1, 2, 3, 4].map(() => e.handle({ action: "start", runId: "zd-4242", input: request(), requestedBy: user })));
    expect(all.filter((x) => !x.body.duplicate)).toHaveLength(1);
    await e.idle();
    expect(w.requests.filter((r) => r.method === "DELETE" && r.path === "/v1/subscriptions/sub_alice")).toHaveLength(1);
    expect(comments(true)).toHaveLength(2);
  });

  it("refuses to cancel someone else's subscription", async () => {
    seed();
    seed({ id: "dev", email: "dev@startupxyz.io" });
    const e = w.engine(productCancellation, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "req", input: request({ subscriptionId: "sub_dev" }), requestedBy: user });
    expect(r.body.agents.find((a: any) => a.name === "policy-research")).toMatchObject({ status: "failed", errorCode: "fatal" });
    expect(action(r.body, "stripe.cancel_subscription")).toBeUndefined();
    expect(r.body.output.decision).toBe("unverified");
    expect(w.state.stripe.subscriptions.every((s) => s.status === "active")).toBe(true);
    expect(w.state.slack.messages[0].text).toContain("could not be verified");
  });

  it("a Zendesk outage leaves the cancellation in place; resume posts each message exactly once", async () => {
    const { sub } = seed();
    const e = w.engine(productCancellation, { now: () => NOW });
    w.faults.push({ method: "PUT", path: /^\/api\/v2\/tickets\/\d+\.json$/, status: 503, body: { error: "ServiceUnavailable" } });
    const r = await e.handle({ action: "start", runId: "req", input: request(), requestedBy: user });
    expect(r.body.outcome).toBe("partial");
    expect(action(r.body, "zendesk.acknowledge")).toMatchObject({ status: "failed", errorCode: "zendesk:ServiceUnavailable" });
    expect(action(r.body, "stripe.cancel_subscription").status).toBe("applied");
    expect(sub.status).toBe("canceled");
    w.faults.length = 0;
    const res = await e.handle({ action: "resume", runId: "req" });
    expect(res.body).toMatchObject({ result: "resumed", outcome: "ok" });
    expect(comments(true)).toHaveLength(2);
    expect(w.requests.filter((x) => x.method === "DELETE")).toHaveLength(1);
  });

  it("without Square, gift cards are neither offered nor issued", async () => {
    seed();
    const e = w.engine(productCancellation, { now: () => NOW, only: ["stripe", "zendesk", "slack"] });
    const r = await e.handle({ action: "start", runId: "req", input: request(), requestedBy: user });
    expect(r.body.agents.find((a: any) => a.name === "gift-card-desk").status).toBe("skipped");
    expect(r.body.output.refundOffer.methods).toEqual(["original_payment", "store_credit"]);
    reply("3");
    const c = await e.handle({ action: "start", runId: "c", input: choice(), requestedBy: user });
    expect(c.body.output).toMatchObject({ decision: "clarify", reason: "gift_card was not offered" });
  });

  it("rejects malformed input before any agent runs", async () => {
    const e = w.engine(productCancellation, { now: () => NOW });
    const bad = await e.handle({ action: "start", input: request({ subscriptionId: "12345" }), requestedBy: user });
    expect(bad.status).toBe(400);
    const noStage = await e.handle({ action: "start", input: { ...choice(), stage: "refund" }, requestedBy: user });
    expect(noStage.status).toBe(400);
    expect(w.requests).toHaveLength(0);
  });
});
