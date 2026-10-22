import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failedPaymentDunning, nextStep, POLICY, type InvoiceState } from "../src/workflows/failed-payment-dunning";
import { providerFactory } from "../src/providers";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const user = { userId: "U_BILLING" };
const DAY = 86_400_000;
const kind = (body: any, k: string) => body.actions.filter((a: any) => a.kind === k);

describe("dunning ladder", () => {
  const inv = (o: Partial<InvoiceState> = {}): InvoiceState => ({ invoiceId: "in_1", customerId: "cus_1", email: "a@example.com", status: "open", amountRemainingMinor: 4_900, currency: "usd", attemptCount: 1, dueMs: NOW - DAY, subscriptionId: "sub_1", subscriptionStatus: "past_due", mrrMinor: 4_900, lastStep: null, backupPaymentMethod: null, ...o });
  it("climbs by attempts and by age, cancellation last", () => {
    expect(nextStep(inv(), NOW).step).toBe("card_update_notice");
    expect(nextStep(inv({ attemptCount: 2 }), NOW).step).toBe("reminder");
    expect(nextStep(inv({ dueMs: NOW - POLICY.finalNoticeAfterDays * DAY }), NOW).step).toBe("final_notice");
    expect(nextStep(inv({ dueMs: NOW - POLICY.cancelAfterDays * DAY }), NOW).step).toBe("cancel");
    expect(nextStep(inv({ dueMs: NOW - POLICY.cancelAfterDays * DAY, subscriptionId: null }), NOW).step).toBe("final_notice");
  });
  it("never repeats or goes back, and stops when the invoice is settled", () => {
    expect(nextStep(inv({ lastStep: "card_update_notice" }), NOW)).toMatchObject({ step: null, why: "already at card_update_notice" });
    expect(nextStep(inv({ attemptCount: 1, lastStep: "reminder" }), NOW).step).toBeNull();
    expect(nextStep(inv({ status: "paid" }), NOW).why).toBe("invoice is paid");
    expect(nextStep(inv({ attemptCount: 0 }), NOW).why).toBe("no failed attempt yet");
  });
  it("retries one backup card on the second failure and escalates high-value accounts", () => {
    expect(nextStep(inv({ attemptCount: 2, backupPaymentMethod: "pm_2" }), NOW).retryBackup).toBe(true);
    expect(nextStep(inv({ attemptCount: 2, mrrMinor: POLICY.escalateMrrMinor }), NOW).escalate).toBe(true);
    expect(nextStep(inv({ mrrMinor: POLICY.escalateMrrMinor }), NOW).escalate).toBe(false);
  });
});

describe("failed-payment-dunning runs", () => {
  let w: World;
  const due = Math.floor((NOW - 2 * DAY) / 1000);
  beforeEach(async () => {
    w = await startWorld();
    const S = w.state.stripe;
    S.customers.push({ id: "cus_d", email: "dana@example.com", metadata: {} });
    S.subscriptions.push({ id: "sub_d", customer: "cus_d", status: "past_due", items: { data: [{ price: { unit_amount: 60_000, recurring: { interval: "month" } }, quantity: 1 }] } });
    S.invoices.push({ id: "in_d1", customer: "cus_d", subscription: "sub_d", status: "open", amount_due: 60_000, amount_remaining: 60_000, currency: "usd", attempt_count: 1, created: due, default_payment_method: "pm_main" });
    S.paymentMethods.push({ id: "pm_main", customer: "cus_d" }, { id: "pm_backup", customer: "cus_d" });
  });
  afterEach(() => w.close());
  const invD = () => w.state.stripe.invoices.find((i) => i.id === "in_d1");
  const failed = (e: any, runId = "dn-1") => e.handle({ action: "start", runId, input: { stage: "payment_failed", invoiceId: "in_d1", financeChannel: "C0FINANCE1", approvers: ["U_CONTROLLER"] }, requestedBy: user });

  it("first failure drafts the card-update notice and records the step; a replay does nothing", async () => {
    const e = w.engine(failedPaymentDunning, { now: () => NOW });
    const r = await failed(e);
    expect(r.body).toMatchObject({ phase: "DONE", output: { mode: "dunning", steps: ["in_d1:card_update_notice"] } });
    expect(w.state.gmail.drafts).toHaveLength(1);
    expect(w.state.stripe.customers.find((c) => c.id === "cus_d").metadata.acme_dunning_in_d1).toBe("card_update_notice");
    const again = await failed(e, "dn-1-replay");
    expect(again.body.output).toMatchObject({ mode: "nothing", skipped: ["in_d1: already at card_update_notice"] });
    expect(w.state.gmail.drafts).toHaveLength(1);
  });

  it("second failure retries the backup card; if it pays, no reminder is sent", async () => {
    invD().attempt_count = 2;
    const r = await failed(w.engine(failedPaymentDunning, { now: () => NOW }));
    expect(kind(r.body, "stripe.retry_backup")[0]).toMatchObject({ status: "applied", detail: { status: "paid" } });
    expect(w.state.gmail.drafts).toHaveLength(0);
    expect(w.state.slack.messages[0].text).toContain("reminder");
  });

  it("second failure with a declining backup card sends the reminder", async () => {
    invD().attempt_count = 2;
    w.state.stripe.paymentMethods[1].id = "pm_cardDeclined";
    const r = await failed(w.engine(failedPaymentDunning, { now: () => NOW }));
    expect(kind(r.body, "stripe.retry_backup")[0].detail).toEqual({ status: "declined" });
    expect(Buffer.from(w.state.gmail.drafts[0].message.raw, "base64url").toString("utf8")).toContain("Reminder");
  });

  it("the age sweep reaches cancellation, which waits for the controller", async () => {
    invD().created = Math.floor((NOW - (POLICY.cancelAfterDays + 1) * DAY) / 1000);
    const e = w.engine(failedPaymentDunning, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "sweep", input: { stage: "sweep", customers: ["dana@example.com"], financeChannel: "C0FINANCE1", approvers: ["U_CONTROLLER"] }, requestedBy: user });
    expect(r.body.phase).toBe("AWAITING_APPROVAL");
    expect(kind(r.body, "stripe.cancel_subscription")[0].status).toBe("pending_approval");
    expect(w.state.stripe.subscriptions[0].status).toBe("past_due");
    await e.handle({ action: "decide", runId: "sweep", decision: "approve", userId: "U_CONTROLLER" });
    expect(w.state.stripe.subscriptions[0].status).toBe("canceled");
  });

  it("a payment between plan and write stops the step", async () => {
    invD().created = Math.floor((NOW - (POLICY.cancelAfterDays + 1) * DAY) / 1000);
    const e = w.engine(failedPaymentDunning, { now: () => NOW });
    await e.handle({ action: "start", runId: "sweep", input: { stage: "sweep", customers: ["dana@example.com"], financeChannel: "C0FINANCE1", approvers: ["U_CONTROLLER"] }, requestedBy: user });
    Object.assign(invD(), { status: "paid", amount_remaining: 0 });
    const r = await e.handle({ action: "decide", runId: "sweep", decision: "approve", userId: "U_CONTROLLER" });
    expect(kind(r.body, "stripe.cancel_subscription")[0]).toMatchObject({ status: "failed", error: expect.stringContaining("invoice is now paid") });
    expect(w.state.stripe.subscriptions[0].status).toBe("past_due");
  });

  it("maps a signed invoice.payment_failed to one run per attempt, ignoring other events and unknown invoices", async () => {
    process.env.DUNNING_SLACK_CHANNEL = "C0FINANCE1";
    const providers = providerFactory(w.endpoints())({});
    const ev = (type: string, id: string) => ({ id: "evt_1", type, data: { object: { id } } });
    expect(await failedPaymentDunning.events!.stripe!(ev("invoice.payment_failed", "in_d1"), providers)).toMatchObject({ runId: "dunning-in_d1-1", input: { stage: "payment_failed", invoiceId: "in_d1" } });
    expect(await failedPaymentDunning.events!.stripe!(ev("invoice.paid", "in_d1"), providers)).toBeNull();
    expect(await failedPaymentDunning.events!.stripe!(ev("invoice.payment_failed", "in_missing"), providers)).toBeNull();
  });

  it("unreadable invoices contact nobody and alert finance", async () => {
    w.faults.push({ method: "GET", path: /^\/v1\/invoices\/in_d1$/, status: 500, body: {} });
    const r = await failed(w.engine(failedPaymentDunning, { now: () => NOW }));
    expect(r.body.output.mode).toBe("blocked");
    expect(w.state.gmail.drafts).toHaveLength(0);
    expect(w.state.slack.messages[0].text).toContain("no customer was contacted");
  });
});
