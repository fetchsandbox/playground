import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileLedgers, revenueReconciliation } from "../src/workflows/revenue-reconciliation";
import { addSub, NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

let w: World;
beforeEach(async () => {
  w = await startWorld();
});
afterEach(() => w.close());

const user = { userId: "U_OPS" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id || a.id.startsWith(`${id}:`));

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
