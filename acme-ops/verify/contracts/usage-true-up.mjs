import { action, actionKind, agent, all, check, command, eq, runs, start, asCase, proofNow } from "./lib.mjs";

// Executable expectations for the committed-use true-up (Stripe billing meters,
// draft invoices and invoice items with idempotency keys, Kit v2 default-approve
// signal for the notice window). Stripe, Gmail and Slack have FetchSandbox
// twins. seed() creates, per check, a customer, an overage price, a subscription
// carrying the commitment in metadata, a billing meter and its usage events,
// then swaps CUS_<check> and the meter id into the inputs. Whatever the twin
// refuses (meters, meter events, subscription metadata) is recorded.
const REVOPS = "C0REVOPS001";
const START = new Date(proofNow() - 86_400_000).toISOString().slice(0, 10);
const END = new Date(proofNow() + 86_400_000).toISOString().slice(0, 10);
const cus = (c) => `cus_SEED_${c}`;
const input = (c, over = {}) => ({ trueUpId: `TU-${c.replaceAll("_", "-")}`.slice(0, 43), meterId: "mtr_SEED", periodStart: START, periodEnd: END, customers: [cus(c)], revopsChannel: REVOPS, owners: { [cus(c)]: "U_AE" }, billingLeads: ["U_BILLING_LEAD"], ...over });
const run = (c, over) => start(c, input(c, over));
const FIXTURES = {
  baseline: { committed: 1000, used: 1300 },
  usage_read_from_meter: { committed: 1000, used: 1300 },
  overage_drafted_once: { committed: 1000, used: 1300 },
  under_commitment_not_billed: { committed: 1000, used: 400 },
  missing_contract_reported: { committed: null, used: 1300 },
  owner_holds_invoice: { committed: 1000, used: 1300 },
  issued_after_notice: { committed: 1000, used: 1300 },
  large_overage_needs_approval: { committed: 1000, used: 20_000_000 },
};

export const checks = [
  check("baseline", "A request starts one recorded run (provider-independent, so every later check is measured)", [run("baseline")], runs([], 1)),
  // Until 2026-10-22 this was the baseline; moved so a missing or divergent twin fails only this check.
  check("baseline_effects", "A true-up reads contracts and usage and posts a summary", [asCase("baseline_effects", run("baseline"))], runs([agent("contracts", "ok"), eq("output.mode", "true_up"), action("slack.post_true_up", "applied")])),
  check("usage_read_from_meter", "Usage for the period is read from the billing meter", [run("usage_read_from_meter")], runs([agent("usage", "ok"), eq("output.owed", 1)])),
  check("overage_drafted_once", "300 units over a 1,000-unit commitment become one draft invoice and a notice", [run("overage_drafted_once"), start("overage_drafted_once", input("overage_drafted_once"), { runId: "again-{{run_id}}" })], all(runs([], 2), runs([actionKind("stripe.draft_overage", "applied"), actionKind("gmail.notice", "applied")], 2))),
  check("under_commitment_not_billed", "Usage under the commitment bills nothing", [run("under_commitment_not_billed")], runs([eq("output.owed", 0), actionKind("stripe.draft_overage", null, 0)])),
  check("missing_contract_reported", "A subscription without a commitment is reported, never guessed", [run("missing_contract_reported")], runs([eq("output.problems", 1), actionKind("stripe.draft_overage", null, 0)])),
  check("owner_holds_invoice", "The account owner's hold during the notice window keeps the invoice in draft", [run("owner_holds_invoice"), command("signal", 1, { actionId: `stripe.issue:${cus("owner_holds_invoice")}`, value: "reject", userId: "U_AE" })], runs([actionKind("stripe.issue", "rejected")])),
  check("issued_after_notice", "With no hold, the invoice is finalized and sent after 7 days (needs clock control)", [run("issued_after_notice"), { method: "POST", path: "/invocations", body: { action: "tick" }, expect_status: 200 }], runs([actionKind("stripe.issue", "applied")])),
  check("large_overage_needs_approval", "An overage over 25,000 waits for approval before any invoice exists", [run("large_overage_needs_approval")], runs([actionKind("stripe.draft_overage", "pending_approval")])),
  check("invalid_input_rejected", "A malformed meter id is rejected before any agent runs", [start("invalid_input_rejected", { ...input("baseline"), meterId: "api calls" }, { expectStatus: 400 })], runs([], 0)),
];

async function seed(legs, log) {
  const trail = [];
  const post = async (path, form) => {
    const res = await fetch(`${legs.stripe.base_url}${path}`, { method: "POST", headers: { authorization: `Bearer ${legs.stripe.api_key}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    if (!res.ok) trail.push(`${path} ${res.status} ${text.slice(0, 300)}`);
    return res.ok ? body : null;
  };
  const meter = await post("/v1/billing/meters", { display_name: "API calls", event_name: "acme_api_calls", "default_aggregation[formula]": "sum", "customer_mapping[event_payload_key]": "stripe_customer_id", "customer_mapping[type]": "by_id" });
  const price = await post("/v1/prices", { currency: "usd", unit_amount: "2", "product_data[name]": "API overage" });
  const base = await post("/v1/prices", { currency: "usd", unit_amount: "0", "recurring[interval]": "month", "product_data[name]": "Committed use" });
  const ids = {};
  for (const [c, f] of Object.entries(FIXTURES)) {
    const customer = await post("/v1/customers", { email: `billing-${c.replaceAll("_", "-")}@trueup.example`, name: c });
    if (!customer?.id) continue;
    ids[c] = customer.id;
    await post("/v1/subscriptions", { customer: customer.id, "items[0][price]": base?.id ?? "", ...(f.committed !== null && price?.id ? { "metadata[acme_committed_units]": String(f.committed), "metadata[acme_overage_price]": price.id } : {}) });
    await post("/v1/billing/meter_events", { event_name: "acme_api_calls", "payload[stripe_customer_id]": customer.id, "payload[value]": String(f.used), timestamp: String(Math.floor(Date.now() / 1000) - 60) });
  }
  for (const chk of checks) {
    const body = chk.actions?.[0]?.body?.input;
    if (!body) continue;
    const key = chk.id === "baseline_effects" ? "baseline" : chk.id;
    const real = ids[key];
    const json = JSON.stringify(chk).replaceAll(cus(key), real ?? cus(key)).replaceAll("mtr_SEED", meter?.id ?? "mtr_SEED");
    Object.assign(chk, JSON.parse(json));
  }
  log("seed", Object.keys(ids).length, "customers; meter", meter?.id ?? "refused", ";", trail.slice(0, 6).join("; "));
  return { ids, meter: meter?.id ?? null, trail };
}

export default {
  workflow: "usage-true-up",
  providers: ["stripe", "gmail", "slack"],
  seed,
  context: {
    goal: "Prove the usage-true-up AgentCore runtime: each committed-use customer's contract (subscription metadata: committed units, overage price, billing contact) vs metered usage (Stripe billing meter event summaries for the period) → overage as a draft invoice with one line (idempotency keys, reused on re-run; approval over 25,000) → Gmail notice draft → finalized and sent after a 7-day window unless the account owner holds it; contracts without a commitment and unreadable usage are reported.",
    workflow: "POST /invocations {action:start}; {action:signal} reject holds an invoice; {action:tick} issues after the window. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline", "baseline_effects"],
    identity_and_access: ["owner_holds_invoice"],
    schema_and_value_boundaries: ["invalid_input_rejected", "missing_contract_reported"],
    amount_currency_quantity: ["overage_drafted_once", "under_commitment_not_billed", "large_overage_needs_approval"],
    duplicate_replay: ["overage_drafted_once"],
    concurrency: "Invoice and line creation carry idempotency keys per true-up and customer.",
    ordering_and_stale_events: "Usage after the period end is excluded by the meter's time window (local tests).",
    delayed_or_missing_events: ["issued_after_notice"],
    provider_auth_and_scopes: "A customer whose usage can't be read is reported; others proceed (local tests).",
    rate_limit_server_error_timeout: "Meter read failures block only that customer (local tests).",
    accepted_effect_response_loss: "Idempotency keys return the first invoice and line on retry.",
    partial_effects_and_recovery: ["owner_holds_invoice"],
    restart_and_durability: "The notice window survives restarts (Kit v2 tests).",
    reconciliation: "Issue re-reads the invoice and skips one no longer in draft.",
    cancellation_refund_entitlements: ["owner_holds_invoice"],
    data_and_privacy_boundaries: "Slack carries customer ids and counts, not contacts.",
    cleanup_and_isolation: ["baseline"],
  },
  evidence: ["acme-ops/src/workflows/usage-true-up.ts", "acme-ops/test/usage-true-up.test.ts"],
};
