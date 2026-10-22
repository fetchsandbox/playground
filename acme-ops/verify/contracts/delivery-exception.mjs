import { action, actionKind, agent, all, check, eq, runs, start, asCase } from "./lib.mjs";

// Executable expectations for delivery exceptions (EasyPost tracker scans,
// proactive Zendesk ticket, Kit v2 48-hour re-check, Shopify replacement draft
// orders). Shopify, Zendesk and Slack have FetchSandbox twins; EasyPost doesn't,
// and its tracker states (stuck, lost, returned, later delivered) are the input
// every branch depends on, so those branches are measured as gaps. seed()
// creates each check's order in the Shopify twin.
const OPS = "C0FULFIL001";
// Numeric placeholders (Shopify order ids are integers), replaced by seeded ids when seeding works.
const order = (c) => `9000${String(Math.abs([...c].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7))).padStart(10, "0")}`;
const input = (c, over = {}) => ({ eventId: `evt_${c}`.slice(0, 68), trackerId: `trk_${c}`, orderId: order(c), opsChannel: OPS, approvers: ["U_LEAD"], ...over });
const event = (c, over) => start(c, input(c, over));

export const checks = [
  check("baseline", "A request starts one recorded run (provider-independent, so every later check is measured)", [event("baseline")], runs([], 1)),
  // Until 2026-10-22 this was the baseline; moved so a missing or divergent twin fails only this check.
  check("baseline_effects", "A tracker update is read together with its order", [asCase("baseline_effects", event("baseline"))], runs([agent("order", "ok"), agent("tracking", "ok")])),
  check("stuck_parcel_customer_told", "A parcel with no scan for 3 days opens one proactive ticket", [event("stuck_parcel_customer_told")], runs([eq("output.mode", "stuck"), actionKind("zendesk.proactive_notice", "applied")])),
  check("lost_parcel_replaced", "A parcel with no scan for 7 days is replaced at no cost", [event("lost_parcel_replaced")], runs([eq("output.mode", "lost"), actionKind("shopify.replacement", "applied")])),
  check("returned_parcel_replaced", "A parcel returned to sender is replaced", [event("returned_parcel_replaced")], runs([eq("output.mode", "returned"), actionKind("shopify.replacement", "applied")])),
  check("delivered_after_notice_solves_ticket", "Delivered within 48 hours: the ticket is solved and nothing is replaced (needs clock control)", [event("delivered_after_notice_solves_ticket"), { method: "POST", path: "/invocations", body: { action: "tick" }, expect_status: 200 }], runs([actionKind("easypost.recheck", "skipped"), actionKind("shopify.replacement", "skipped")])),
  check("redelivered_webhook_one_ticket", "The same tracker update delivered twice opens one ticket", [event("redelivered_webhook_one_ticket"), start("redelivered_webhook_one_ticket", input("redelivered_webhook_one_ticket"), { runId: "again-{{run_id}}" })], all(runs([], 2))),
  check("tracker_unreadable_reported", "A tracker that can't be read changes nothing for the customer", [event("tracker_unreadable_reported", { trackerId: "trk_does_not_exist" })], runs([eq("output.mode", "blocked"), action("slack.post_unreadable", "applied")])),
  check("invalid_input_rejected", "A malformed tracker id is rejected before any agent runs", [start("invalid_input_rejected", { ...input("baseline"), trackerId: "1Z 999 tracking" }, { expectStatus: 400 })], runs([], 0)),
];

async function seed(legs, log) {
  const leg = legs["shopify-admin"];
  const trail = [];
  const ids = {};
  for (const chk of checks) {
    if (chk.id === "invalid_input_rejected" || chk.id === "baseline_effects") continue;
    const res = await fetch(`${leg.base_url}/admin/api/2026-01/orders.json`, { method: "POST", headers: { authorization: `Bearer ${leg.api_key}`, "content-type": "application/json" }, body: JSON.stringify({ order: { email: `${chk.id.replaceAll("_", "-")}@ship.example`, line_items: [{ title: "Mug", quantity: 2, price: "32.00", variant_id: 1001 }] } }) });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    const id = body?.order?.id ?? body?.id;
    if (!res.ok || !id) { trail.push(`order ${chk.id}: ${res.status} ${text.slice(0, 300)}`); continue; }
    ids[chk.id] = String(id);
  }
  for (const [i, chk] of checks.entries()) {
    const key = chk.id === "baseline_effects" ? "baseline" : chk.id;
    if (ids[key]) checks[i] = JSON.parse(JSON.stringify(chk).replaceAll(order(key), ids[key]));
  }
  log("seed", Object.keys(ids).length, "orders;", trail.slice(0, 6).join("; "));
  return { ids, trail };
}

export default {
  workflow: "delivery-exception",
  providers: ["shopify-admin", "zendesk", "slack"],
  seed,
  context: {
    goal: "Prove the delivery-exception AgentCore runtime: an EasyPost tracker update for a Shopify order → classified from scans (delayed, stuck at 3 days, lost at 7, returned, exception) → one proactive Zendesk ticket per shipment with a public message → 48-hour re-check that solves the ticket if delivered or sends a free replacement (100% discounted Shopify draft order, once per shipment, approval over 200); lost and returned parcels are replaced at once.",
    workflow: "POST /invocations {action:start} per tracker event; {action:tick} fires the re-check; {action:decide} releases a held replacement. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline", "baseline_effects"],
    identity_and_access: "Replacements over 200 need a fulfillment lead (local tests).",
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: ["lost_parcel_replaced"],
    duplicate_replay: ["redelivered_webhook_one_ticket"],
    concurrency: "The original order's tag guards a second replacement.",
    ordering_and_stale_events: ["delivered_after_notice_solves_ticket"],
    delayed_or_missing_events: ["stuck_parcel_customer_told", "delivered_after_notice_solves_ticket"],
    provider_auth_and_scopes: ["tracker_unreadable_reported"],
    rate_limit_server_error_timeout: ["tracker_unreadable_reported"],
    accepted_effect_response_loss: "Tickets are found by external id; replacements by the order tag.",
    partial_effects_and_recovery: ["returned_parcel_replaced"],
    restart_and_durability: "The 48-hour re-check survives restarts (Kit v2 tests).",
    reconciliation: "The re-check re-reads the tracker before replacing.",
    cancellation_refund_entitlements: ["lost_parcel_replaced"],
    data_and_privacy_boundaries: "Slack carries tracker and order ids only.",
    cleanup_and_isolation: ["baseline"],
  },
  evidence: ["acme-ops/src/workflows/delivery-exception.ts", "acme-ops/test/delivery-exception.test.ts"],
};
