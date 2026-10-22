import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blockers, treasuryPaymentApproval } from "../src/workflows/treasury-payment-approval";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const DAY = 86_400_000;
const user = { userId: "U_MAKER" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const input = (over: object = {}) => ({
  paymentId: "PAY-2026-0042",
  type: "wire",
  amount: 40_000_00,
  currency: "usd",
  originatingAccountId: "ia_ops",
  receivingAccountId: "ea_northwind",
  purpose: "Invoice NW-1182",
  valueDate: "2026-10-14",
  maker: "U_MAKER",
  approvers: { treasury: ["U_TREAS", "U_MAKER", "U_TREAS_2"], cfo: ["U_CFO", "U_TREAS"] },
  dailyLimit: 1_000_000_00,
  treasuryChannel: "C0FINANCE1",
  ...over,
});
const sig = (kind: string, userId: string, value: "approve" | "reject" = "approve") => ({ action: "signal" as const, runId: "p", actionId: `${kind}:PAY-2026-0042`, value, userId });

describe("blockers", () => {
  it("stops unverified beneficiaries, sanctions matches and the daily limit", () => {
    const b = { name: "Northwind", verified: true, ageDays: 400 };
    expect(blockers(b, [], 0, { amount: 100, dailyLimit: 1000 })).toEqual([]);
    expect(blockers({ ...b, verified: false, ageDays: 2 }, [], 0, { amount: 100, dailyLimit: 1000 })).toEqual(["beneficiary account is not verified and was added 2 day(s) ago"]);
    expect(blockers(b, ["X (SDN)"], 950, { amount: 100, dailyLimit: 1000 })).toEqual(["sanctions match: X (SDN)", "daily limit: 1050 would exceed 1000"]);
  });
});

describe("treasury-payment-approval runs", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
    w.state.moderntreasury.counterparties.push({ id: "cp_nw", name: "Northwind Traders" });
    w.state.moderntreasury.externalAccounts.push({ id: "ea_northwind", counterparty_id: "cp_nw", verification_status: "verified", created_at: new Date(NOW - 400 * DAY).toISOString() });
  });
  afterEach(() => w.close());

  it("a checker who isn't the maker releases one payment order; settlement is checked the next day", async () => {
    const clock = { t: NOW };
    const e = w.engine(treasuryPaymentApproval, { now: () => clock.t });
    const r = await e.handle({ action: "start", runId: "p", input: input(), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "approval", approvals: ["treasury"], cutoff: "2026-10-14T21:00:00.000Z", possibleDuplicates: 0 });
    expect((await e.handle(sig("treasury.approve", "U_MAKER"))).status).toBe(403);
    const d = await e.handle(sig("treasury.approve", "U_TREAS"));
    expect(action(d.body, "moderntreasury.release:PAY-2026-0042").status).toBe("applied");
    expect(w.state.moderntreasury.orders).toEqual([expect.objectContaining({ type: "wire", amount: 4_000_000, currency: "USD", direction: "credit", metadata: { acme_payment_id: "PAY-2026-0042" } })]);
    expect(w.state.slack.messages.at(-1)).toMatchObject({ channel: "U_MAKER", text: expect.stringMatching(/was released: payment order po_\d+/) });
    w.state.moderntreasury.orders[0].status = "returned";
    clock.t = NOW + DAY + 1;
    await e.handle({ action: "tick" });
    expect(w.state.slack.messages.at(-1).text).toMatch(/is returned a day after release/);
  });

  it("over 100,000 the CFO approves too, and can't be the checker", async () => {
    const e = w.engine(treasuryPaymentApproval, { now: () => NOW });
    await e.handle({ action: "start", runId: "p", input: input({ amount: 250_000_00 }), requestedBy: user });
    await e.handle(sig("treasury.approve", "U_TREAS"));
    expect(w.state.moderntreasury.orders).toHaveLength(0);
    expect((await e.handle(sig("cfo.approve", "U_TREAS"))).status).toBe(403);
    await e.handle(sig("cfo.approve", "U_CFO"));
    expect(w.state.moderntreasury.orders).toHaveLength(1);
  });

  it("no approval by the cut-off: the payment lapses and nothing is sent", async () => {
    const clock = { t: NOW };
    const e = w.engine(treasuryPaymentApproval, { now: () => clock.t });
    await e.handle({ action: "start", runId: "p", input: input(), requestedBy: user });
    clock.t = Date.parse("2026-10-14T21:00:01Z");
    await e.handle({ action: "tick" });
    const s = (await e.handle({ action: "status", runId: "p" })).body;
    expect(action(s, "treasury.approve:PAY-2026-0042").status).toBe("rejected");
    expect(action(s, "moderntreasury.release:PAY-2026-0042").status).toBe("skipped");
    expect(w.state.moderntreasury.orders).toHaveLength(0);
    expect(w.state.slack.messages.at(-1).text).toMatch(/was not released; nothing was sent/);
  });

  it("an order already created for the payment is reused; a duplicate-looking payment is flagged", async () => {
    w.state.moderntreasury.orders.push({ id: "po_old", status: "completed", amount: 40_000_00, direction: "credit", receiving_account_id: "ea_northwind", originating_account_id: "ia_ops", effective_date: "2026-10-12", created_at: new Date(NOW - 2 * DAY).toISOString(), metadata: { acme_payment_id: "PAY-2026-0031" } });
    w.state.moderntreasury.orders.push({ id: "po_same", status: "approved", amount: 40_000_00, direction: "credit", receiving_account_id: "ea_northwind", originating_account_id: "ia_ops", effective_date: "2026-10-14", created_at: new Date(NOW).toISOString(), metadata: { acme_payment_id: "PAY-2026-0042" } });
    const e = w.engine(treasuryPaymentApproval, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "p", input: input(), requestedBy: user });
    expect(r.body.output.possibleDuplicates).toBe(1);
    const d = await e.handle(sig("treasury.approve", "U_TREAS"));
    expect(action(d.body, "moderntreasury.release:PAY-2026-0042")).toMatchObject({ ref: "po_same", detail: { reused: true } });
    expect(w.state.moderntreasury.orders).toHaveLength(2);
  });

  it("an unverified new beneficiary, a sanctions match or the daily limit blocks the payment", async () => {
    w.state.moderntreasury.externalAccounts[0].verification_status = "unverified";
    w.state.moderntreasury.externalAccounts[0].created_at = new Date(NOW - 3 * DAY).toISOString();
    w.state.screening.entries.push({ name: "Northwind Traders", source: "SDN", score: 100 });
    const r = await w.engine(treasuryPaymentApproval, { now: () => NOW }).handle({ action: "start", runId: "p", input: input({ dailyLimit: 10_000_00 }), requestedBy: user });
    expect(r.body.output.mode).toBe("blocked");
    expect(r.body.output.reasons).toHaveLength(3);
    expect(r.body.actions.map((a: any) => a.kind)).toEqual(["slack.post_blocked"]);
  });

  it("a beneficiary changed after approval is not paid", async () => {
    const e = w.engine(treasuryPaymentApproval, { now: () => NOW });
    await e.handle({ action: "start", runId: "p", input: input(), requestedBy: user });
    w.state.moderntreasury.externalAccounts[0].verification_status = "pending_verification";
    const d = await e.handle(sig("treasury.approve", "U_TREAS"));
    expect(action(d.body, "moderntreasury.release:PAY-2026-0042")).toMatchObject({ status: "failed", error: expect.stringMatching(/now pending_verification/) });
    expect(w.state.moderntreasury.orders).toHaveLength(0);
  });
});
