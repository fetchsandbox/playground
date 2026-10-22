import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trueUp, usageTrueUp } from "../src/workflows/usage-true-up";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const DAY = 86_400_000;
const user = { userId: "U_BILLING" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const input = (over: object = {}) => ({ trueUpId: "TU-2026-Q3", meterId: "mtr_api_calls", periodStart: "2026-07-01", periodEnd: "2026-10-01", customers: ["cus_alice", "cus_dev"], revopsChannel: "C0FINANCE1", owners: { cus_alice: "U_AE_ALICE" }, billingLeads: ["U_BILLING_LEAD"], ...over });
const ts = (d: string) => Math.floor(Date.parse(`${d}T12:00:00Z`) / 1000);

describe("trueUp", () => {
  const c = { customer: "c", committed: 1000, overagePrice: "price_over", unitAmount: 2, currency: "usd", billingEmail: "ap@x" };
  it("bills whole units over the commitment and reports what it can't compute", () => {
    expect(trueUp(c, 1500.5)).toMatchObject({ overageUnits: 501, amount: 1002, problem: null });
    expect(trueUp(c, 900).amount).toBe(0);
    expect(trueUp({ ...c, committed: null }, 1500).problem).toMatch(/no commitment/);
    expect(trueUp(c, null).problem).toBe("usage could not be read");
  });
});

describe("usage-true-up runs", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
    w.state.stripe.prices.push({ id: "price_api_overage", active: true, currency: "usd", unit_amount: 2 });
    w.state.stripe.subscriptions.push({ id: "sub_alice_cu", customer: "cus_alice", status: "active", items: { data: [] }, metadata: { acme_committed_units: "100000", acme_overage_price: "price_api_overage", acme_billing_email: "ap@acmecorp.com" } });
    w.state.stripe.meterEvents.push({ meter: "mtr_api_calls", customer: "cus_alice", ts: ts("2026-08-01"), value: 130_000 }, { meter: "mtr_api_calls", customer: "cus_alice", ts: ts("2026-10-02"), value: 999_999 });
  });
  afterEach(() => w.close());

  it("drafts the overage invoice and notice, then issues it after the notice window", async () => {
    const clock = { t: NOW };
    const e = w.engine(usageTrueUp, { now: () => clock.t });
    const r = await e.handle({ action: "start", runId: "t", input: input(), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "true_up", customers: 2, owed: 1, problems: 1, totalOverage: 60000 });
    const inv = w.state.stripe.invoices.find((i: any) => i.metadata?.acme_true_up === "TU-2026-Q3");
    expect(inv).toMatchObject({ customer: "cus_alice", status: "draft", amount_due: 60000 });
    expect(Buffer.from(w.state.gmail.drafts[0].message.raw, "base64url").toString()).toMatch(/30000 units are billed at the contracted overage rate: \$600\.00/);
    expect(w.state.slack.messages.at(-1).text).toMatch(/cus_dev: contract has no commitment or overage price/);
    clock.t = NOW + 7 * DAY + 1;
    await e.handle({ action: "tick" });
    expect(inv).toMatchObject({ status: "open", sent: true });
  });

  it("the account owner can hold a disputed invoice during the window", async () => {
    const e = w.engine(usageTrueUp, { now: () => NOW });
    await e.handle({ action: "start", runId: "t", input: input(), requestedBy: user });
    expect((await e.handle({ action: "signal", runId: "t", actionId: "stripe.issue:cus_alice", value: "reject", userId: "U_RANDOM" })).status).toBe(403);
    const r = await e.handle({ action: "signal", runId: "t", actionId: "stripe.issue:cus_alice", value: "reject", userId: "U_AE_ALICE" });
    expect(action(r.body, "stripe.issue:cus_alice").status).toBe("rejected");
    expect(w.state.stripe.invoices.find((i: any) => i.metadata?.acme_true_up)?.status).toBe("draft");
  });

  it("a re-run of the same true-up never creates a second invoice", async () => {
    const e = w.engine(usageTrueUp, { now: () => NOW });
    await e.handle({ action: "start", runId: "t1", input: input(), requestedBy: user });
    const r = await e.handle({ action: "start", runId: "t2", input: input(), requestedBy: user });
    expect(action(r.body, "stripe.draft_overage:cus_alice").detail).toEqual({ reused: true });
    expect(w.state.stripe.invoices.filter((i: any) => i.metadata?.acme_true_up === "TU-2026-Q3")).toHaveLength(1);
    expect(w.state.stripe.invoiceItems).toHaveLength(1);
  });

  it("a large overage waits for approval before any invoice exists", async () => {
    w.state.stripe.meterEvents.push({ meter: "mtr_api_calls", customer: "cus_alice", ts: ts("2026-09-01"), value: 2_000_000 });
    const r = await w.engine(usageTrueUp, { now: () => NOW }).handle({ action: "start", runId: "t", input: input(), requestedBy: user });
    expect(action(r.body, "stripe.draft_overage:cus_alice").status).toBe("pending_approval");
    expect(w.state.stripe.invoices.some((i: any) => i.metadata?.acme_true_up)).toBe(false);
  });

  it("an unreadable meter for one customer blocks only that customer", async () => {
    w.faults.push({ method: "GET", path: /event_summaries$/, status: 500, body: { error: { type: "api_error" } }, times: 1 });
    const r = await w.engine(usageTrueUp, { now: () => NOW }).handle({ action: "start", runId: "t", input: input({ customers: ["cus_alice", "cus_dev"] }), requestedBy: user });
    expect(r.body.output).toMatchObject({ owed: 0, problems: 2 });
    expect(w.state.slack.messages.at(-1).text).toMatch(/cus_alice: usage could not be read/);
  });
});
