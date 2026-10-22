import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gateTransfers, partnerPayoutRun, POLICY, type Line } from "../src/workflows/partner-payout-run";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const user = { userId: "U_FINANCE" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const kind = (body: any, k: string) => body.actions.filter((a: any) => a.kind === k);

describe("payout limits", () => {
  const l = (partnerId: string, amountMinor: number): Line => ({ partnerId, account: `acct_${partnerId}`, amountMinor });
  it("pays automatically up to the single and run limits, then asks for approval", () => {
    const g = gateTransfers([l("P-a", POLICY.autoTransferMaxMinor + 1), ...Array.from({ length: 11 }, (_, i) => l(`P-${String(i).padStart(2, "0")}`, 240_000))]);
    expect(g.mode).toBe("pay");
    expect(g.transfers.find((t) => t.partnerId === "P-a")).toMatchObject({ gate: "approval", why: "above the single-transfer limit" });
    // 10 x $2,400 = $24,000 fits the $25,000 run limit; the 11th does not.
    expect(g.transfers.filter((t) => t.gate === "auto")).toHaveLength(10);
    expect(g.transfers.find((t) => t.partnerId === "P-10")).toMatchObject({ gate: "approval", why: "run auto-payout limit reached" });
  });
  it("halts beyond the ceiling", () => {
    expect(gateTransfers([l("P-big", POLICY.hardMaxTotalMinor + 1)])).toMatchObject({ mode: "halted", transfers: [] });
    expect(gateTransfers(Array.from({ length: POLICY.hardMaxPartners + 1 }, (_, i) => l(`P-${i}`, 100))).mode).toBe("halted");
  });
});

describe("partner-payout-run runs", () => {
  let w: World;
  const input = (over: object = {}) => ({
    payoutRunId: "PO-2026-10",
    period: "2026-10",
    partners: [
      { partnerId: "P-1001", account: "acct_p1001", amountMinor: 120_000 },
      { partnerId: "P-1002", account: "acct_p1002", amountMinor: 45_000 },
    ],
    financeChannel: "C0FINANCE1",
    approvers: ["U_CONTROLLER"],
    ...over,
  });
  beforeEach(async () => {
    w = await startWorld();
    w.state.stripe.accounts.push({ id: "acct_p1001", capabilities: { transfers: "active" } }, { id: "acct_p1002" }, { id: "acct_off", capabilities: { transfers: "inactive" } });
  });
  afterEach(() => w.close());

  it("pays each partner once, records the run and posts it; a re-run pays nothing", async () => {
    const e = w.engine(partnerPayoutRun, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "PO-2026-10", input: input(), requestedBy: user });
    expect(r.body).toMatchObject({ phase: "DONE", outcome: "ok", output: { mode: "pay", transfers: 2, amountMinor: 165_000 } });
    expect(w.state.stripe.transfers.map((t) => [t.metadata.acme_partner, t.amount, t.destination, t.transfer_group])).toEqual([
      ["P-1001", 120_000, "acct_p1001", "PO-2026-10"],
      ["P-1002", 45_000, "acct_p1002", "PO-2026-10"],
    ]);
    expect(w.state.asana.tasks[0].name).toContain("PO-2026-10");
    const rec = await e.handle({ action: "reconcile", runId: "PO-2026-10" });
    expect(action(rec.body, "stripe.transfer:P-1001").reconcile.status).toBe("match");

    const again = await e.handle({ action: "start", runId: "PO-2026-10-retrigger", input: input(), requestedBy: user });
    expect(again.body.output).toMatchObject({ mode: "nothing" });
    expect(again.body.output.skipped).toHaveLength(2);
    expect(w.state.stripe.transfers).toHaveLength(2);
  });

  it("a lost response is retried with the same key and returns the same transfer, never a second payment", async () => {
    process.env.PROVIDER_RETRIES = "2";
    try {
      w.state.stripe.loseTransferResponses = 1;
      const e = w.engine(partnerPayoutRun, { now: () => NOW });
      const r = await e.handle({ action: "start", runId: "PO", input: input(), requestedBy: user });
      expect(action(r.body, "stripe.transfer:P-1001")).toMatchObject({ status: "applied", attempts: 1 });
      expect(w.state.stripe.transfers.filter((t) => t.metadata.acme_partner === "P-1001")).toHaveLength(1);
      expect(action(r.body, "stripe.transfer:P-1001").ref).toBe(w.state.stripe.transfers[0].id);
      const posts = w.requests.filter((x) => x.method === "POST" && x.path === "/v1/transfers");
      expect(posts).toHaveLength(3); // P-1001 twice (lost, retried), P-1002 once
      expect(posts[0]!.headers["idempotency-key"]).toBe(posts[1]!.headers["idempotency-key"]);
    } finally {
      process.env.PROVIDER_RETRIES = "0";
    }
  });

  it("parks large transfers for approval; the approver releases them once", async () => {
    const e = w.engine(partnerPayoutRun, { now: () => NOW });
    const big = input({ partners: [{ partnerId: "P-1001", account: "acct_p1001", amountMinor: 400_000 }, { partnerId: "P-1002", account: "acct_p1002", amountMinor: 45_000 }] });
    const r = await e.handle({ action: "start", runId: "PO", input: big, requestedBy: user });
    expect(r.body.phase).toBe("AWAITING_APPROVAL");
    expect(action(r.body, "stripe.transfer:P-1001")).toMatchObject({ gate: "approval", status: "pending_approval" });
    expect(action(r.body, "stripe.transfer:P-1002").status).toBe("applied");
    expect((await e.handle({ action: "decide", runId: "PO", decision: "approve", userId: "U_INTERN" })).status).toBe(403);
    await e.handle({ action: "decide", runId: "PO", decision: "approve", userId: "U_CONTROLLER" });
    expect(w.state.stripe.transfers.filter((t) => t.metadata.acme_partner === "P-1001")).toEqual([expect.objectContaining({ amount: 400_000 })]);
  });

  it("skips partners whose account can't receive transfers or doesn't exist", async () => {
    const e = w.engine(partnerPayoutRun, { now: () => NOW });
    const r = await e.handle({
      action: "start",
      runId: "PO",
      input: input({ partners: [{ partnerId: "P-1001", account: "acct_p1001", amountMinor: 1_000 }, { partnerId: "P-off", account: "acct_off", amountMinor: 1_000 }, { partnerId: "P-gone", account: "acct_gone", amountMinor: 1_000 }] }),
      requestedBy: user,
    });
    expect(r.body.output.skipped).toEqual([
      { partnerId: "P-off", reason: "transfers capability inactive" },
      { partnerId: "P-gone", reason: "no such connected account" },
    ]);
    expect(kind(r.body, "stripe.transfer")).toHaveLength(1);
  });

  it("fails closed: an unreadable ledger or a partner already paid twice pays nobody", async () => {
    const e = w.engine(partnerPayoutRun, { now: () => NOW });
    w.faults.push({ method: "GET", path: /^\/v1\/transfers$/, status: 500, body: { error: { code: "api_error" } } });
    const r = await e.handle({ action: "start", runId: "PO", input: input(), requestedBy: user });
    expect(r.body.output).toMatchObject({ mode: "blocked" });
    expect(kind(r.body, "stripe.transfer")).toHaveLength(0);
    w.faults.length = 0;
    w.state.stripe.transfers.push({ id: "tr_a", amount: 1, transfer_group: "PO-2026-10", metadata: { acme_partner: "P-1001" } }, { id: "tr_b", amount: 1, transfer_group: "PO-2026-10", metadata: { acme_partner: "P-1001" } });
    const r2 = await e.handle({ action: "start", runId: "PO-2", input: input(), requestedBy: user });
    expect(r2.body.output).toMatchObject({ mode: "blocked", reason: expect.stringContaining("paid twice") });
  });

  it("halts a run beyond the ceiling and pays nothing", async () => {
    const e = w.engine(partnerPayoutRun, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "PO", input: input({ partners: [{ partnerId: "P-1001", account: "acct_p1001", amountMinor: POLICY.hardMaxTotalMinor + 1 }] }), requestedBy: user });
    expect(r.body.output.mode).toBe("halted");
    expect(w.state.stripe.transfers).toHaveLength(0);
    expect(w.state.slack.messages[0].text).toContain("ceiling");
  });

  it("concurrent deliveries of one run pay once", async () => {
    const e = w.engine(partnerPayoutRun, { now: () => NOW });
    await Promise.all([1, 2, 3, 4].map(() => e.handle({ action: "start", runId: "PO", input: input(), requestedBy: user })));
    await e.idle();
    expect(w.state.stripe.transfers).toHaveLength(2);
  });

  it("rejects a statement listing a partner twice", async () => {
    const e = w.engine(partnerPayoutRun, { now: () => NOW });
    const r = await e.handle({ action: "start", input: input({ partners: [{ partnerId: "P-1", account: "acct_a", amountMinor: 1 }, { partnerId: "P-1", account: "acct_a", amountMinor: 1 }] }), requestedBy: user });
    expect(r.status).toBe(400);
    expect(w.requests).toHaveLength(0);
  });
});
