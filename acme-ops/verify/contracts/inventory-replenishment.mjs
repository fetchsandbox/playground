import { action, actionKind, agent, all, check, eq, runs, start } from "./lib.mjs";

// Executable expectations for inventory replenishment (velocity from Shopify
// orders, stock from Shopify inventory levels, open POs and new POs in NetSuite,
// a Kit v2 late-receipt timer). Shopify, Gmail and Slack have FetchSandbox
// twins; NetSuite doesn't, so open-PO reads and PO creation are measured as
// gaps. seed() creates a product with variants in the Shopify twin and 28 days
// of orders against them; the twin's variant and inventory item ids are swapped
// into the inputs. Twin refusals are recorded.
const OPS = "C0SUPPLY001";
const SUPPLIERS = { "401": { name: "Ceramica", email: "orders@ceramica.example" } };
const item = (sku, v) => ({ sku, variantId: v, netsuiteItemId: "101", supplierId: "401", unitCost: 500, leadTimeDays: 10, safetyDays: 5, moq: 1, casePack: 1 });
const input = (c, over = {}) => ({ runId: `REPL-${c.replaceAll("_", "-")}`.slice(0, 45), locationId: "LOCATION", department: "3", items: [item("MUG-BLK", "VARIANT_A")], suppliers: SUPPLIERS, opsChannel: OPS, approvers: ["U_BUYER"], ...over });
const replenish = (c, over) => start(c, input(c, over));

export const checks = [
  check("baseline", "A replenishment run reads sales, stock and open POs and posts a summary", [replenish("baseline")], runs([action("slack.post_replenishment", "applied")])),
  check("velocity_from_orders", "28-day sales velocity is computed from Shopify orders", [replenish("velocity_from_orders")], runs([agent("velocity", "ok")])),
  check("stock_from_inventory_levels", "Available units come from Shopify inventory levels at the location", [replenish("stock_from_inventory_levels")], runs([agent("stock", "ok")])),
  check("open_pos_counted", "Units on open purchase orders are read from the ERP", [replenish("open_pos_counted")], runs([agent("open-pos", "ok")])),
  check("below_reorder_point_po_raised", "A SKU below its reorder point gets a purchase order and a supplier email", [replenish("below_reorder_point_po_raised")], runs([eq("output.reorder", 1), actionKind("netsuite.create_po", "applied"), actionKind("gmail.po_to_supplier", "applied")])),
  check("large_po_needs_buyer", "A PO over 10,000 waits for a buyer", [replenish("large_po_needs_buyer", { items: [{ ...item("MUG-BLK", "VARIANT_A"), unitCost: 50_000 }] })], runs([actionKind("netsuite.create_po", "pending_approval")])),
  check("late_receipt_escalated", "A PO not received two days after its due date is escalated (needs clock control)", [replenish("late_receipt_escalated"), { method: "POST", path: "/invocations", body: { action: "tick" }, expect_status: 200 }], runs([actionKind("receiving.late_check", "applied")])),
  check("shopify_rate_limited", "When stock can't be read nothing is ordered", [replenish("shopify_rate_limited")], all(runs([eq("output.reorder", 0), actionKind("netsuite.create_po", null, 0)])), { fault: { provider: "shopify-admin", scenario: "rate_limited", evidence: "refusal" } }),
  check("invalid_input_rejected", "A non-numeric variant id is rejected before any agent runs", [start("invalid_input_rejected", { ...input("baseline"), items: [item("MUG-BLK", "black-mug")] }, { expectStatus: 400 })], runs([], 0)),
];

async function seed(legs, log) {
  const leg = legs["shopify-admin"];
  const trail = [];
  const call = async (method, path, json) => {
    const res = await fetch(`${leg.base_url}${path}`, { method, headers: { authorization: `Bearer ${leg.api_key}`, "content-type": "application/json" }, body: json ? JSON.stringify(json) : undefined });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    if (!res.ok) trail.push(`${method} ${path} ${res.status} ${text.slice(0, 80)}`);
    return body;
  };
  const product = await call("POST", "/admin/api/2026-01/products.json", { product: { title: "Mug", variants: [{ sku: "MUG-BLK", price: "12.00", inventory_management: "shopify" }] } });
  const variant = product?.product?.variants?.[0] ?? product?.variants?.[0];
  const locations = await call("GET", "/admin/api/2026-01/locations.json");
  const location = locations?.locations?.[0]?.id;
  if (variant?.inventory_item_id && location) await call("POST", "/admin/api/2026-01/inventory_levels/set.json", { inventory_item_id: variant.inventory_item_id, location_id: location, available: 20 });
  let orders = 0;
  for (let d = 1; d <= 28 && variant?.id; d++) if (await call("POST", "/admin/api/2026-01/orders.json", { order: { line_items: [{ variant_id: variant.id, quantity: 2 }], created_at: new Date(Date.now() - d * 86_400_000).toISOString() } })) orders++;
  trail.push(`variant ${variant?.id ?? "none"}, location ${location ?? "none"}, ${orders} orders`);
  const swap = JSON.stringify(checks).replaceAll("VARIANT_A", String(variant?.id ?? "1")).replaceAll("LOCATION", String(location ?? "1"));
  JSON.parse(swap).forEach((c, i) => Object.assign(checks[i], c));
  log("seed", trail.slice(0, 6).join("; "));
  return { trail };
}

export default {
  workflow: "inventory-replenishment",
  providers: ["shopify-admin", "gmail", "slack"],
  seed,
  context: {
    goal: "Prove the inventory-replenishment AgentCore runtime: planned SKUs → 28-day velocity from Shopify orders, available units from Shopify inventory levels, open-PO units from NetSuite SuiteQL → reorder point and order quantity (MOQ, case pack) → one NetSuite PO per supplier per day (idempotent external id; approval over 10,000) → supplier email draft → late-receipt escalation two days after the due date; stockout risks flagged to expedite.",
    workflow: "POST /invocations {action:start}; {action:decide} releases a held PO; {action:tick} fires the late-receipt check. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["large_po_needs_buyer"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: ["below_reorder_point_po_raised", "velocity_from_orders"],
    duplicate_replay: "One PO per supplier per day by external id; open POs count toward the position (local tests).",
    concurrency: "PO creation looks up its external id first.",
    ordering_and_stale_events: "Cancelled orders don't count toward velocity (local tests).",
    delayed_or_missing_events: ["late_receipt_escalated"],
    provider_auth_and_scopes: ["shopify_rate_limited"],
    rate_limit_server_error_timeout: ["shopify_rate_limited"],
    accepted_effect_response_loss: "PO creation is looked up by external id first.",
    partial_effects_and_recovery: "SKUs whose data is missing are reported, others proceed (local tests).",
    restart_and_durability: "The late-receipt timer survives restarts (Kit v2 tests).",
    reconciliation: ["open_pos_counted"],
    cancellation_refund_entitlements: "No customer-facing change.",
    data_and_privacy_boundaries: "Orders are read for quantities only.",
    cleanup_and_isolation: ["baseline"],
  },
  evidence: ["acme-ops/src/workflows/inventory-replenishment.ts", "acme-ops/test/inventory-replenishment.test.ts"],
};
