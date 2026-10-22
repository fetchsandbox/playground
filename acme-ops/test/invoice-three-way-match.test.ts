import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invoiceThreeWayMatch, matchBill } from "../src/workflows/invoice-three-way-match";
import { providerFactory } from "../src/providers";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const user = { userId: "U_AP_BOT" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);

const po = (id: string, lines: [number, string, number, number, number, number][]) => ({ id, tranId: `PO-${id}`, entity: { id: "731" }, item: { items: lines.map(([line, item, quantity, quantityReceived, quantityBilled, rate]) => ({ line, item: { id: item }, quantity, quantityReceived, quantityBilled, rate })) } });
const bill = (id: string, o: object = {}) => ({ id, tranId: `INV-${id}`, entity: { id: "731" }, total: 1000, tranDate: "2026-10-12", approvalStatus: { id: "1" }, createdBy: { id: "U_AP_CLERK" }, item: { items: [{ item: { id: "W-1" }, quantity: 10, rate: 100, orderDoc: { id: "500" }, orderLine: 1 }] }, ...o });

describe("three-way match", () => {
  const pos = { "500": po("500", [[1, "W-1", 10, 10, 0, 100]]) };
  it("classifies by risk: match, variance within tolerance, exceptions, duplicates", () => {
    expect(matchBill(bill("1") as any, pos, [])).toMatchObject({ verdict: "match", reasons: [] });
    expect(matchBill(bill("1", { item: { items: [{ item: { id: "W-1" }, quantity: 10, rate: 101, orderDoc: { id: "500" }, orderLine: 1 }] } }) as any, pos, [])).toMatchObject({ verdict: "variance" });
    expect(matchBill(bill("1", { item: { items: [{ item: { id: "W-1" }, quantity: 10, rate: 110, orderDoc: { id: "500" }, orderLine: 1 }] } }) as any, pos, []).reasons[0]).toBe("line 1: price 110 vs PO 100 (10.0%, $100.00 over)");
    expect(matchBill(bill("1", { item: { items: [{ item: { id: "W-1" }, quantity: 12, rate: 100, orderDoc: { id: "500" }, orderLine: 1 }] } }) as any, pos, []).reasons[0]).toBe("line 1: billed 12, received and unbilled 10");
    expect(matchBill(bill("1", { item: { items: [{ item: { id: "W-1" }, quantity: 1, rate: 100 }] } }) as any, pos, []).reasons[0]).toBe("line 1: no purchase order");
    expect(matchBill(bill("1") as any, pos, ["9"])).toMatchObject({ verdict: "duplicate" });
    expect(matchBill(bill("1", { total: 30_000, item: { items: [{ item: { id: "W-1" }, quantity: 10, rate: 100, orderDoc: { id: "500" }, orderLine: 1 }] } }) as any, pos, []).verdict).toBe("variance");
  });
});

describe("invoice-three-way-match runs", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
    const N = w.state.netsuite;
    N.purchaseOrders.push(po("500", [[1, "W-1", 10, 10, 0, 100]]), po("501", [[1, "W-2", 5, 5, 0, 200]]), po("502", [[1, "W-3", 4, 2, 0, 50]]));
    N.vendorBills.push(
      bill("11"),
      bill("12", { tranId: "INV-12", total: 1010, item: { items: [{ item: { id: "W-2" }, quantity: 5, rate: 202, orderDoc: { id: "501" }, orderLine: 1 }] } }),
      bill("13", { tranId: "INV-13", total: 200, item: { items: [{ item: { id: "W-3" }, quantity: 4, rate: 50, orderDoc: { id: "502" }, orderLine: 1 }] } }),
      bill("14", { tranId: "INV-11", total: 1000, approvalStatus: { id: "1" } }),
    );
  });
  afterEach(() => w.close());
  const run = (e: any) => e.handle({ action: "start", runId: "ap", input: { batchId: "AP-2026-10-22", apChannel: "C0FINANCE1", approvers: ["U_AP_LEAD", "U_AP_CLERK"], buyers: ["U_BUYER"] }, requestedBy: user });
  const status = (id: string) => w.state.netsuite.vendorBills.find((b) => b.id === id);

  it("approves clean matches, waits on variances, holds exceptions and duplicates", async () => {
    const e = w.engine(invoiceThreeWayMatch, { now: () => NOW });
    const r = await run(e);
    // 11 and 14 share an invoice number: both are possible duplicates, neither is approved.
    expect(r.body.output).toMatchObject({ bills: 4, match: 0, variance: 1, exception: 1, duplicate: 2 });
    expect(status("11")).toMatchObject({ paymentHold: true, custbody_acme_hold_reason: expect.stringContaining("duplicate") });
    expect(status("13")).toMatchObject({ paymentHold: true, custbody_acme_hold_reason: expect.stringContaining("billed 4, received and unbilled 2") });
    expect(w.state.asana.tasks).toHaveLength(3);

    // The clerk who entered bill 12 can't approve its variance; the AP lead can.
    expect((await e.handle({ action: "signal", runId: "ap", actionId: "netsuite.approve_bill:12", value: "approve", userId: "U_AP_CLERK" })).status).toBe(403);
    await e.handle({ action: "signal", runId: "ap", actionId: "netsuite.approve_bill:12", value: "approve", userId: "U_AP_LEAD" });
    expect(status("12").approvalStatus.id).toBe("2");
    // A buyer releases the over-billed bill as billed.
    await e.handle({ action: "signal", runId: "ap", actionId: "netsuite.buyer_release:13", value: "approve", userId: "U_BUYER" });
    expect(status("13")).toMatchObject({ paymentHold: false, approvalStatus: { id: "2" } });
    expect((await e.handle({ action: "evidence", runId: "ap" })).body.verified).toBe(true);
  });

  it("a clean match is approved automatically, and not if the bill changed since the match", async () => {
    w.state.netsuite.vendorBills = [bill("21")];
    const e = w.engine(invoiceThreeWayMatch, { now: () => NOW });
    const r = await run(e);
    expect(action(r.body, "netsuite.approve_bill:21").status).toBe("applied");
    expect(status("21").approvalStatus.id).toBe("2");

    // Bill 22 is edited (total raised) between the match and the approval.
    w.state.netsuite.vendorBills = [bill("22")];
    const base = providerFactory(w.endpoints());
    let reads = 0;
    const providers = (c: Record<string, string>) => {
      const p = base(c);
      const get = p.netsuite!.getVendorBill.bind(p.netsuite!);
      p.netsuite!.getVendorBill = async (id: string) => {
        if (++reads === 2) status("22").total = 1500;
        return get(id);
      };
      return p;
    };
    const r2 = await w.engine(invoiceThreeWayMatch, { now: () => NOW, providers }).handle({ action: "start", runId: "ap2", input: { batchId: "AP-2026-10-23", billIds: ["22"], apChannel: "C0FINANCE1", buyers: ["U_BUYER"] }, requestedBy: user });
    expect(action(r2.body, "netsuite.approve_bill:22")).toMatchObject({ status: "skipped", detail: { reason: "bill total changed to $1,500.00 since the match" } });
    expect(status("22").approvalStatus.id).toBe("1");
  });

  it("an unreadable ERP approves nothing and alerts AP", async () => {
    w.faults.push({ method: "POST", path: /suiteql$/, status: 503, body: {} });
    const r = await run(w.engine(invoiceThreeWayMatch, { now: () => NOW }));
    expect(r.body.output).toEqual({ mode: "blocked" });
    expect(w.state.slack.messages[0].text).toContain("nothing was approved");
  });
});
