import { action, agent, all, check, eq, runs, start } from "./lib.mjs";

// seed() creates every check's Shopify order on the session's Shopify Admin
// twin and swaps ORDER_<check> for its id. The ERP (NetSuite) and carrier
// (EasyPost) legs are named in the checks as ordinary executable expectations;
// FetchSandbox has no twin for either (validate_integration: "Unknown
// providers"), so the session carries only shopify-admin and slack and the
// receipt shows what can't be measured. The Shopify twin models Admin REST
// versions 2020-01..2021-01 only, so the runtime is pointed at 2020-04.
const CHANNEL = "C0OPS00001";
const APPROVER = "U_OPS_LEAD";

const PAID = {
  email: "buyer@example.com",
  financial_status: "paid",
  currency: "USD",
  total_price: "50.00",
  line_items: [{ sku: "W-1", title: "Widget", quantity: 2, price: "25.00" }],
  shipping_address: { name: "Pat Buyer", address1: "1 Main St", city: "Austin", province_code: "TX", zip: "78701", country_code: "US" },
};
const FIXTURES = {
  baseline: PAID,
  sales_order_booked_in_erp: PAID,
  label_bought_under_limit: PAID,
  customer_gets_tracking: PAID,
  shipped_order_not_shipped_again: { ...PAID, fulfill: true },
  unpaid_order_held: { ...PAID, financial_status: "pending" },
  incomplete_address_held: { ...PAID, shipping_address: { name: "Pat Buyer", address1: "1 Main St" } },
  cancelled_order_ignored: { ...PAID, cancelled_at: "2026-10-20T10:00:00Z" },
  shopify_rate_limited: PAID,
};
const order = (caseId) => `ORDER_${caseId}`;
const ship = (caseId) => start(caseId, { orderId: order(caseId), opsChannel: CHANNEL, approvers: [APPROVER] });

export const checks = [
  check("baseline", "A paid order is read from Shopify and its outcome posted to operations", [ship("baseline")], runs([eq("phase", "DONE"), agent("order-check", "ok"), action("slack.post_order", "applied")])),
  check("sales_order_booked_in_erp", "A paid, complete order is booked as a NetSuite sales order (external id shopify-<order>)", [ship("sales_order_booked_in_erp")], runs([eq("output.mode", "ship"), action(`netsuite.book_sales_order:${order("sales_order_booked_in_erp")}`, "applied")])),
  check("label_bought_under_limit", "After the sales order, the cheapest EasyPost label under $50 is bought", [ship("label_bought_under_limit")], runs([action(`easypost.buy_label:${order("label_bought_under_limit")}`, "applied")])),
  check("customer_gets_tracking", "The Shopify order gets a fulfillment with the label's tracking number", [ship("customer_gets_tracking")], runs([eq("phase", "DONE"), action(`shopify.fulfill:${order("customer_gets_tracking")}`, "applied")])),
  check("shipped_order_not_shipped_again", "An order that already has a fulfillment is not shipped again", [ship("shipped_order_not_shipped_again")], runs([eq("output.mode", "already_shipped")])),
  check("unpaid_order_held", "An order that isn't paid is held: no sales order, no label", [ship("unpaid_order_held")], runs([eq("output.mode", "hold"), eq("output.reason", "order is pending")])),
  check("incomplete_address_held", "An order without a complete shipping address is held", [ship("incomplete_address_held")], runs([eq("output.mode", "hold"), eq("output.reason", "shipping address is incomplete")])),
  check("cancelled_order_ignored", "A cancelled order is not shipped", [ship("cancelled_order_ignored")], runs([eq("output.mode", "nothing")])),
  check("shopify_rate_limited", "When the order can't be read nothing ships and operations is alerted", [ship("shopify_rate_limited")], all(runs([agent("order-check", "failed"), eq("output.mode", "blocked"), action("slack.post_order", "applied")])), { fault: { provider: "shopify-admin", scenario: "rate_limited", evidence: "refusal" } }),
  check("invalid_input_rejected", "A malformed order id is rejected before any agent runs", [start("invalid_input_rejected", { orderId: "5001; DROP", opsChannel: CHANNEL }, { expectStatus: 400 })], runs([], 0)),
];

async function seed(legs, log) {
  const leg = legs["shopify-admin"];
  const call = async (method, path, json) => {
    const res = await fetch(`${leg.base_url}${path}`, { method, headers: { authorization: `Bearer ${leg.api_key}`, "content-type": "application/json" }, body: json ? JSON.stringify(json) : undefined });
    const body = await res.json();
    if (!res.ok) throw new Error(`seed ${method} ${path} → ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    return body;
  };
  const ids = {};
  for (const [caseId, f] of Object.entries(FIXTURES)) {
    const { fulfill, ...o } = f;
    const created = await call("POST", "/admin/api/2020-04/orders.json", { order: o });
    // The twin returns the id beside the order object, not inside it.
    const id = String(created.order?.id ?? created.id);
    ids[caseId] = id;
    if (fulfill) await call("POST", `/admin/api/2020-04/orders/${id}/fulfillments.json`, { fulfillment: { tracking_number: "1Z999AA10123456784", tracking_company: "UPS" } });
  }
  for (const c of checks) {
    const real = ids[c.id];
    if (!real) continue;
    const ph = order(c.id);
    for (const a of c.actions ?? []) if (a.body?.input?.orderId === ph) a.body.input.orderId = real;
    const fix = (where) => where?.forEach((w) => { if (typeof w.equals === "string" && w.equals.endsWith(`:${ph}`)) w.equals = w.equals.replace(`:${ph}`, `:${real}`); fix(w.where); });
    const walk = (a) => { if (!a) return; fix(a.where); a.all_of?.forEach(walk); };
    walk(c.assertion);
  }
  log("seed", Object.keys(ids).length, "Shopify orders");
  return ids;
}

export default {
  workflow: "order-to-cash",
  providers: ["shopify-admin", "slack"],
  seed,
  appEnv: { SHOPIFY_API_VERSION: "2020-04" },
  context: {
    goal: "Prove the order-to-cash AgentCore runtime: a Shopify order → parallel order read (Shopify Admin) and ERP lookup (NetSuite) → for a paid, complete, unshipped order: NetSuite sales order, cheapest EasyPost label under $50, Shopify fulfillment with tracking; nothing ships without a sales order; unpaid, incomplete, cancelled and shipped orders are held or ignored; outcome posted to Slack.",
    workflow: "POST /invocations {action:start} decides and ships or holds the order. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: "Large orders and expensive labels wait for approval (local tests).",
    schema_and_value_boundaries: ["invalid_input_rejected", "incomplete_address_held"],
    amount_currency_quantity: ["label_bought_under_limit"],
    duplicate_replay: ["shipped_order_not_shipped_again"],
    concurrency: "One label per order under concurrent deliveries (local tests).",
    ordering_and_stale_events: ["unpaid_order_held", "cancelled_order_ignored"],
    delayed_or_missing_events: "Orders arrive by direct call; no provider events are consumed.",
    provider_auth_and_scopes: ["shopify_rate_limited"],
    rate_limit_server_error_timeout: ["shopify_rate_limited"],
    accepted_effect_response_loss: "The label purchase carries an Idempotency-Key and a bought shipment is refused a second postage (local tests).",
    partial_effects_and_recovery: ["sales_order_booked_in_erp", "label_bought_under_limit", "customer_gets_tracking"],
    restart_and_durability: "Not re-measured here.",
    reconciliation: "Sales order and label reconcile against NetSuite and EasyPost (local tests).",
    cancellation_refund_entitlements: ["cancelled_order_ignored"],
    data_and_privacy_boundaries: "Slack gets the order id, total and outcome; addresses go only to the carrier.",
    cleanup_and_isolation: ["baseline"],
  },
  evidence: ["acme-ops/src/workflows/order-to-cash.ts", "acme-ops/src/providers/commerce.ts", "acme-ops/test/order-to-cash.test.ts"],
};
