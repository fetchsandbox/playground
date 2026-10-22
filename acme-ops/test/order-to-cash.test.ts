import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decide, orderFrom, orderToCash, POLICY } from "../src/workflows/order-to-cash";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const user = { userId: "U_OPS" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);

const ORDER = {
  id: "5001",
  email: "buyer@example.com",
  financial_status: "paid",
  currency: "USD",
  total_price: "50.00",
  line_items: [{ sku: "W-1", title: "Widget", quantity: 2, price: "25.00" }],
  shipping_address: { name: "Pat Buyer", address1: "1 Main St", city: "Austin", province_code: "TX", zip: "78701", country_code: "US" },
};

describe("fulfillment decision", () => {
  const o = (over: object = {}) => orderFrom("5001", { ...ORDER, ...over } as any, 0);
  it("ships a paid, complete order only when the ERP and the carrier are there", () => {
    expect(decide(o(), { salesOrderId: null }, "ok", true)).toMatchObject({ mode: "ship", needsSalesOrder: true, bookGate: "auto" });
    expect(decide(o(), undefined, "skipped", true)).toMatchObject({ mode: "blocked", reason: "ERP not connected" });
    expect(decide(o(), { salesOrderId: null }, "ok", false).reason).toBe("carrier not connected");
  });
  it("holds unpaid, incomplete and unlabelled orders; ignores cancelled and shipped ones", () => {
    expect(decide(o({ financial_status: "pending" }), { salesOrderId: null }, "ok", true).reason).toBe("order is pending");
    expect(decide(o({ shipping_address: { address1: "1 Main St" } }), { salesOrderId: null }, "ok", true).reason).toBe("shipping address is incomplete");
    expect(decide(o({ line_items: [{ title: "x", quantity: 1, price: "1.00" }] }), { salesOrderId: null }, "ok", true).reason).toBe("order lines lack SKUs or quantities");
    expect(decide(o({ cancelled_at: "2026-10-01T00:00:00Z" }), undefined, "skipped", true).mode).toBe("nothing");
    expect(decide(orderFrom("5001", ORDER as any, 1), undefined, "skipped", true).mode).toBe("already_shipped");
  });
  it("large orders need approval", () => {
    expect(decide(o({ total_price: String(POLICY.autoBookMaxMinor / 100 + 1) }), { salesOrderId: null }, "ok", true).bookGate).toBe("approval");
  });
});

describe("order-to-cash runs", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
    w.state.shopify.orders.push(structuredClone(ORDER));
  });
  afterEach(() => w.close());
  const ship = (e: any, runId = "o2c") => e.handle({ action: "start", runId, input: { orderId: "5001", opsChannel: "C0CSOPS001", approvers: ["U_OPS_LEAD"] }, requestedBy: user });

  it("books the sales order, buys the cheapest label and fulfils with tracking; a re-run ships nothing", async () => {
    const e = w.engine(orderToCash, { now: () => NOW });
    const r = await ship(e);
    expect(r.body).toMatchObject({ phase: "DONE", outcome: "ok", output: { mode: "ship" } });
    expect(w.state.netsuite.salesOrders).toEqual([expect.objectContaining({ externalId: "shopify-5001" })]);
    expect(w.state.easypost.shipments[0].selected_rate).toMatchObject({ carrier: "USPS", rate: "7.40" });
    expect(w.state.shopify.fulfillments).toEqual([expect.objectContaining({ order_id: "5001", tracking_number: w.state.easypost.shipments[0].tracking_code, tracking_company: "USPS" })]);
    const rec = (await e.handle({ action: "reconcile", runId: "o2c" })).body;
    expect([action(rec, "netsuite.book_sales_order:5001").reconcile.status, action(rec, "easypost.buy_label:5001").reconcile.status]).toEqual(["match", "match"]);
    const again = await ship(e, "o2c-2");
    expect(again.body.output.mode).toBe("already_shipped");
    expect(w.state.easypost.shipments).toHaveLength(1);
  });

  it("without the ERP nothing ships: no label, no fulfillment", async () => {
    const r = await ship(w.engine(orderToCash, { now: () => NOW, only: ["shopify", "easypost", "slack"] }));
    expect(r.body.output).toMatchObject({ mode: "blocked", reason: "ERP not connected" });
    expect(w.state.easypost.shipments).toHaveLength(0);
    expect(w.state.shopify.fulfillments).toHaveLength(0);
  });

  it("an existing sales order is reused, never booked twice", async () => {
    w.state.netsuite.salesOrders.push({ id: "77", externalId: "shopify-5001" });
    const r = await ship(w.engine(orderToCash, { now: () => NOW }));
    expect(action(r.body, "netsuite.book_sales_order:5001")).toMatchObject({ ref: "77", detail: { reused: true } });
    expect(w.state.netsuite.salesOrders).toHaveLength(1);
  });

  it("an expensive label is refused at write time and the order is not fulfilled", async () => {
    w.state.easypost.rates = [{ carrier: "FedEx", service: "Overnight", rate: "82.00", currency: "USD" }];
    const r = await ship(w.engine(orderToCash, { now: () => NOW }));
    expect(action(r.body, "easypost.buy_label:5001")).toMatchObject({ status: "failed", error: expect.stringContaining("above the automatic limit") });
    expect(w.state.shopify.fulfillments).toHaveLength(0);
  });

  it("an ERP outage stops the label; an unpaid order is held", async () => {
    w.faults.push({ method: "POST", path: /salesOrder$/, status: 503, body: {} });
    const r = await ship(w.engine(orderToCash, { now: () => NOW }));
    expect(action(r.body, "easypost.buy_label:5001")).toMatchObject({ status: "failed", error: expect.stringContaining("no sales order") });
    w.faults.length = 0;
    w.state.shopify.orders[0].financial_status = "pending";
    const r2 = await ship(w.engine(orderToCash, { now: () => NOW }), "o2c-2");
    expect(r2.body.output).toMatchObject({ mode: "hold", reason: "order is pending" });
  });

  it("concurrent deliveries buy one label", async () => {
    const e = w.engine(orderToCash, { now: () => NOW });
    await Promise.all([1, 2, 3].map(() => ship(e)));
    await e.idle();
    expect(w.state.easypost.shipments.filter((s) => s.tracking_code)).toHaveLength(1);
  });
});
