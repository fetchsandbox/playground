import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inventoryReplenishment, need } from "../src/workflows/inventory-replenishment";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const DAY = 86_400_000;
const user = { userId: "U_PLANNER" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const item = (sku: string, variantId: string, over: object = {}) => ({ sku, variantId, netsuiteItemId: variantId.slice(-3), supplierId: "401", unitCost: 500, leadTimeDays: 10, safetyDays: 5, moq: 1, casePack: 1, ...over });
const input = (over: object = {}) => ({ runId: "REPL-2026-10-14-DC1", locationId: "9", department: "3", items: [item("MUG-BLK", "1001"), item("MUG-WHT", "1002"), item("TEE-L", "1003", { supplierId: "402", casePack: 12, moq: 24 })], suppliers: { "401": { name: "Ceramica", email: "orders@ceramica.example" }, "402": { name: "Threadworks", email: "po@threadworks.example" } }, opsChannel: "C0ONBOARD1", approvers: ["U_BUYER"], ...over });

describe("need", () => {
  const it0 = { sku: "A", variantId: "1", netsuiteItemId: "1", supplierId: "1", unitCost: 1, leadTimeDays: 10, safetyDays: 5, moq: 1, casePack: 1 };
  it("orders up to lead + review + safety when below the reorder point, rounded to MOQ and case pack", () => {
    expect(need(it0, { sku: "A", velocity: 2, available: 20, incoming: 0 })).toMatchObject({ qty: 38, reorderPoint: 30, stockoutBeforeArrival: false });
    expect(need(it0, { sku: "A", velocity: 2, available: 20, incoming: 20 }).qty).toBe(0);
    expect(need({ ...it0, moq: 50, casePack: 12 }, { sku: "A", velocity: 2, available: 20, incoming: 0 }).qty).toBe(60);
    expect(need(it0, { sku: "A", velocity: 2, available: 5, incoming: 0 }).stockoutBeforeArrival).toBe(true);
    expect(need(it0, { sku: "A", velocity: 2, available: null, incoming: 0 }).problem).toBe("stock level unavailable");
  });
});

describe("inventory-replenishment runs", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
    w.state.shopify.variants.push({ id: 1001, sku: "MUG-BLK", inventory_item_id: 5001 }, { id: 1002, sku: "MUG-WHT", inventory_item_id: 5002 }, { id: 1003, sku: "TEE-L", inventory_item_id: 5003 });
    w.state.shopify.levels.push({ inventory_item_id: 5001, location_id: 9, available: 20 }, { inventory_item_id: 5002, location_id: 9, available: 500 }, { inventory_item_id: 5003, location_id: 9, available: 3 });
    // 56 black mugs (2/day) and 28 tees (1/day) sold in the last 28 days; a cancelled order doesn't count.
    for (let d = 1; d <= 28; d++) w.state.shopify.orders.push({ id: 7000 + d, created_at: new Date(NOW - d * DAY).toISOString(), line_items: [{ variant_id: 1001, quantity: 2 }, { variant_id: 1003, quantity: 1 }] });
    w.state.shopify.orders.push({ id: 7999, created_at: new Date(NOW - DAY).toISOString(), cancelled_at: new Date(NOW).toISOString(), line_items: [{ variant_id: 1002, quantity: 900 }] });
  });
  afterEach(() => w.close());

  it("raises one PO per supplier, drafts it to the supplier and flags a stockout risk", async () => {
    const r = await w.engine(inventoryReplenishment, { now: () => NOW }).handle({ action: "start", runId: "r", input: input(), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "replenish", reorder: 2, units: 38 + 36, stockoutRisk: 1, blocked: 0 });
    expect(w.state.netsuite.purchaseOrders.map((p: any) => [p.externalId, p.item.items.map((l: any) => l.quantity)])).toEqual([["REPL-2026-10-14-401", [38]], ["REPL-2026-10-14-402", [36]]]);
    expect(Buffer.from(w.state.gmail.drafts[0].message.raw, "base64url").toString()).toMatch(/MUG-BLK: 38 units/);
    expect(w.state.slack.messages.at(-1).text).toMatch(/expedite: TEE-L/);
  });

  it("open POs count toward the position, so a re-run orders nothing new", async () => {
    w.state.netsuite.purchaseOrders.push({ id: "60", tranId: "PO60", entity: { id: "401" }, item: { items: [{ item: { id: "001" }, quantity: 40, quantityReceived: 0 }] } });
    const e = w.engine(inventoryReplenishment, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "r", input: input(), requestedBy: user });
    expect(action(r.body, "netsuite.create_po:401")).toBeUndefined();
    const again = await e.handle({ action: "start", runId: "r2", input: input(), requestedBy: user });
    expect(again.body.output.reorder).toBe(0);
    expect(w.state.netsuite.purchaseOrders).toHaveLength(2);
  });

  it("a PO already raised today for the supplier (e.g. before a crash) is reused", async () => {
    w.state.netsuite.purchaseOrders.push({ id: "61", tranId: "PO61", externalId: "REPL-2026-10-14-402", entity: { id: "402" } });
    const r = await w.engine(inventoryReplenishment, { now: () => NOW }).handle({ action: "start", runId: "r", input: input(), requestedBy: user });
    expect(action(r.body, "netsuite.create_po:402")).toMatchObject({ ref: "61", detail: { reused: true } });
  });

  it("a PO not fully received two days after its due date is escalated", async () => {
    const clock = { t: NOW };
    const e = w.engine(inventoryReplenishment, { now: () => clock.t });
    await e.handle({ action: "start", runId: "r", input: input({ items: [item("MUG-BLK", "1001")] }), requestedBy: user });
    w.state.netsuite.purchaseOrders[0].item.items[0].quantityReceived = 20;
    clock.t = NOW + 12 * DAY + 1;
    await e.handle({ action: "tick" });
    expect(w.state.slack.messages.at(-1).text).toMatch(/was due 2026-10-24 and is 1 line\(s\) short \(item 001: 20\/38\)/);
  });

  it("a large PO waits for a buyer", async () => {
    const r = await w.engine(inventoryReplenishment, { now: () => NOW }).handle({ action: "start", runId: "r", input: input({ items: [item("MUG-BLK", "1001", { unitCost: 50_000 })] }), requestedBy: user });
    expect(action(r.body, "netsuite.create_po:401").status).toBe("pending_approval");
    expect(w.state.netsuite.purchaseOrders).toHaveLength(0);
  });

  it("when stock can't be read, nothing is ordered for those SKUs", async () => {
    w.faults.push({ method: "GET", path: /inventory_levels\.json$/, status: 503, body: {} });
    const r = await w.engine(inventoryReplenishment, { now: () => NOW }).handle({ action: "start", runId: "r", input: input(), requestedBy: user });
    expect(r.body.output).toMatchObject({ reorder: 0, blocked: 3 });
    expect(w.state.netsuite.purchaseOrders).toHaveLength(0);
  });
});
