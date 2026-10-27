import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { monthEndClose, periodBounds, reconcile } from "../src/workflows/month-end-close";
import { startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-02T08:00:00Z");
const user = { userId: "U_CLOSE_BOT" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const sec = (d: string) => Date.parse(`${d}T12:00:00Z`) / 1000;

describe("close helpers", () => {
  it("period bounds and one-to-one payout/deposit matching within three days", () => {
    expect(periodBounds("2026-10")).toEqual({ start: "2026-10-01", end: "2026-10-31", next: "2026-11-01" });
    const r = reconcile(
      [{ id: "po1", amountMinor: 10_000, arrival: "2026-10-10", feesMinor: 300 }, { id: "po2", amountMinor: 10_000, arrival: "2026-10-20", feesMinor: 290 }, { id: "po3", amountMinor: 5_000, arrival: "2026-10-30", feesMinor: 150 }],
      [{ id: "d1", amountMinor: 10_000, date: "2026-10-12" }, { id: "d2", amountMinor: 10_000, date: "2026-10-26" }, { id: "d3", amountMinor: 5_000, date: "2026-11-01" }],
    );
    expect(r.matched).toEqual([{ payout: "po1", deposit: "d1" }, { payout: "po3", deposit: "d3" }]);
    expect(r.unmatchedPayouts.map((x) => x.id)).toEqual(["po2"]);
    expect(r.unmatchedDeposits.map((x) => x.id)).toEqual(["d2"]);
    expect(r.feesMinor).toBe(740);
  });
});

describe("month-end-close runs", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
    const S = w.state.stripe;
    S.payouts.push({ id: "po_a", amount: 120_000, currency: "usd", arrival_date: sec("2026-10-15"), status: "paid" }, { id: "po_b", amount: 80_000, currency: "usd", arrival_date: sec("2026-10-31"), status: "paid" });
    S.payoutTxns.push({ id: "txn_1", payout: "po_a", amount: 123_600, fee: 3_600, type: "charge", currency: "usd" }, { id: "txn_2", payout: "po_b", amount: 82_400, fee: 2_400, type: "charge", currency: "usd" });
    w.state.plaid.transactions["access-bank-op"] = [
      { transaction_id: "bt_1", amount: -1200, date: "2026-10-16", name: "STRIPE TRANSFER", iso_currency_code: "USD" },
      { transaction_id: "bt_2", amount: -800, date: "2026-11-02", name: "STRIPE TRANSFER", iso_currency_code: "USD" },
      { transaction_id: "bt_3", amount: 54.2, date: "2026-10-03", name: "AWS", iso_currency_code: "USD" },
    ];
    w.state.netsuite.unbilledReceipts = 4_250.5;
    w.state.netsuite.periods.push({ id: "77", periodName: "Oct 2026" });
  });
  afterEach(() => w.close());
  const input = { period: "2026-10", periodName: "Oct 2026", bankAccessToken: "access-bank-op", closeChannel: "C0FINANCE1", approvers: ["U_CONTROLLER"] };
  const signal = (e: any, actionId: string, value = "approve") => e.handle({ action: "signal", runId: "close", actionId, value, userId: "U_CONTROLLER" });

  it("reconciles, posts journals on approval, reminds, and locks the period only after sign-off", async () => {
    const clock = { t: T0 };
    const e = w.engine(monthEndClose, { now: () => clock.t });
    const r = await e.handle({ action: "start", runId: "close", input, requestedBy: user });
    expect(r.body).toMatchObject({ phase: "WAITING", output: { mode: "closing", matched: 2, exceptions: 0, feesMinor: 6_000, accrualMinor: 425_050 } });
    expect(w.state.netsuite.journals).toHaveLength(0);

    await signal(e, "netsuite.journal:fees:2026-10");
    expect(w.state.netsuite.journals[0]).toMatchObject({ externalId: "close-2026-10-fees", tranDate: "2026-10-31", line: { items: [{ account: { id: "6150" }, debit: 60 }, { account: { id: "1105" }, credit: 60 }] } });

    // Day 2: the accrual still waits, so the controller is reminded.
    clock.t = T0 + 2 * DAY + 1;
    await e.handle({ action: "tick" });
    expect(w.state.slack.messages.at(-1).text).toContain("1 journal(s) await controller approval");

    await signal(e, "netsuite.journal:accrual:2026-10");
    expect(w.state.netsuite.journals[1]).toMatchObject({ externalId: "close-2026-10-accrual", reversalDate: "2026-11-01" });
    expect(w.state.netsuite.periods[0].allLocked).toBeUndefined();
    const done = await signal(e, "controller.signoff:2026-10");
    expect(done.body).toMatchObject({ phase: "DONE", outcome: "ok" });
    expect(w.state.netsuite.periods[0]).toMatchObject({ apLocked: true, arLocked: true, allLocked: true });
    expect(w.state.slack.messages.at(-1).text).toContain("closed and locked");
    expect((await e.handle({ action: "evidence", runId: "close" })).body.verified).toBe(true);
  });

  it("an unmatched payout becomes an exception task; a rejected sign-off never locks", async () => {
    w.state.plaid.transactions["access-bank-op"]!.splice(1, 1);
    const e = w.engine(monthEndClose, { now: () => T0 });
    const r = await e.handle({ action: "start", runId: "close", input, requestedBy: user });
    expect(r.body.output).toMatchObject({ matched: 1, exceptions: 1 });
    expect(w.state.asana.tasks[0].notes).toContain("payout po_b $800.00 (2026-10-31) has no bank deposit");
    await signal(e, "netsuite.journal:fees:2026-10");
    await signal(e, "netsuite.journal:accrual:2026-10", "reject");
    const s = await signal(e, "controller.signoff:2026-10", "reject");
    expect(action(s.body, "netsuite.lock_period:2026-10").status).toBe("skipped");
    expect(w.state.netsuite.periods[0].allLocked).toBeUndefined();
    expect(w.state.slack.messages.at(-1).text).toContain("NOT locked");
  });

  it("a journal is never posted twice", async () => {
    w.state.netsuite.journals.push({ id: "900", externalId: "close-2026-10-fees" });
    const e = w.engine(monthEndClose, { now: () => T0 });
    await e.handle({ action: "start", runId: "close", input, requestedBy: user });
    const r = await signal(e, "netsuite.journal:fees:2026-10");
    expect(action(r.body, "netsuite.journal:fees:2026-10")).toMatchObject({ ref: "900", detail: { reused: true } });
    expect(w.state.netsuite.journals).toHaveLength(1);
  });

  it("without the bank feed the close is blocked and nothing locks", async () => {
    w.faults.push({ method: "POST", path: /^\/transactions\/get$/, status: 500, body: {} });
    const r = await w.engine(monthEndClose, { now: () => T0 }).handle({ action: "start", runId: "close", input, requestedBy: user });
    expect(r.body).toMatchObject({ phase: "DONE", output: { mode: "blocked" } });
    expect(w.state.slack.messages[0].text).toContain("close blocked");
  });
});
