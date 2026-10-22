import { action, actionKind, agent, all, check, command, eq, noAction, restart, runs, start } from "./lib.mjs";

// Direct signed-event mode: the verifier signs Stripe events with the session's
// webhook secret and delivers them to the runtime's real handler, POST
// /webhooks/stripe. Each check's checkout charges a real payment on the Stripe
// twin first; the event names that payment ({{step1.actions.0.ref}}), and the
// runtime re-reads it from Stripe before granting anything.
// seed() creates one Stripe customer per check: po-<check>@orders.test.
const CHANNEL = "C0BILLING01";
const APPROVER = "U_SALES_LEAD";
/** Replaced by seed() with a WorkOS organization created on the session's twin. */
const ORG = "org_seeded";

const email = (caseId) => `po-${caseId.replaceAll("_", "-")}@orders.test`;
const orderId = (caseId) => `ORD-${caseId.replaceAll("_", "-")}`.slice(0, 44);
const checkout = (caseId, over = {}) => ({
  stage: "checkout",
  orderId: orderId(caseId),
  customer: { email: email(caseId) },
  plan: "team",
  seats: 3,
  organizationId: ORG,
  paymentMethod: "pm_card_visa",
  opsChannel: CHANNEL,
  approvers: [APPROVER],
  ...over,
});
const buy = (caseId, over) => start(caseId, checkout(caseId, over), { runId: `${caseId.replaceAll("_", "-")}-co-{{run_id}}` });
/** A signed payment_intent.succeeded naming the payment the checkout in step `step` created. */
const paid = (step = 1, extra = {}) => ({ event: { provider: "stripe", type: "payment_intent.succeeded", payload: { id: `{{step${step}.actions.0.ref}}`, object: "payment_intent", status: "succeeded" } }, expect_status: 200, ...extra });
/** The webhook-started order run: the case's run that has no charge action. */
const orderRun = (where) => runs([noAction("stripe.charge_order"), ...where]);
const granted = (status = "applied", extra = []) => actionKind("workos.grant_access", status, 1, extra);

function faultedAtEvent(id, name, provider, scenario, assertions) {
  return check(id, name, [buy(id), paid()], all(...assertions), { fault: { provider, scenario, evidence: "refusal" } });
}

export const checks = [
  check("baseline", "A seat purchase charges the customer's saved card once and records the order on the payment", [buy("baseline")], runs([eq("phase", "DONE"), eq("outcome", "ok"), action("stripe.charge_order", "applied", 1, [eq("attempts", 1)]), action("slack.post_order", "applied")])),
  check(
    "payment_event_provisions",
    "The order's signed payment event grants WorkOS access, marks the CRM customer, drafts the welcome and records the provisioning run on the payment",
    [buy("payment_event_provisions"), paid()],
    all(
      runs([], 2),
      orderRun([eq("phase", "DONE"), eq("outcome", "ok"), granted("applied", [eq("attempts", 1)]), actionKind("hubspot.mark_customer", "applied"), actionKind("gmail.draft_welcome", "applied"), actionKind("stripe.record_provisioned", "applied")]),
    ),
  ),
  check("provisioning_reconciled", "Reconcile reads the WorkOS membership and the payment's provisioning record back", [buy("provisioning_reconciled"), paid(), command("reconcile", 1)], runs([action("stripe.charge_order", "applied", 1, [eq("reconciled", "match")])])),
  check("exact_replay_once", "An exact replay of the delivered event lands on the same order run and grants nothing twice", [buy("exact_replay_once"), paid(), { event: { provider: "stripe", replay_of: "{{step2.event_id}}" }, expect_status: 200 }], all(runs([], 2), orderRun([eq("duplicateStarts", 1), granted("applied", [eq("attempts", 1)])]))),
  check("concurrent_deliveries_once", "Four simultaneous deliveries of the payment event grant access once", [buy("concurrent_deliveries_once"), paid(1, { concurrency: 4 })], all(runs([], 2), orderRun([granted("applied", [eq("attempts", 1)])]))),
  check("unknown_payment_ignored", "A signed event for a payment Stripe doesn't know is acknowledged and starts nothing", [{ event: { provider: "stripe", type: "payment_intent.succeeded", payload: { id: "pi_doesnotexist0000", object: "payment_intent", status: "succeeded" } }, expect_status: 200 }], runs([], 0)),
  check(
    "stale_event_after_refund",
    "A payment refunded before its success event arrives grants nothing: the runtime re-reads Stripe instead of trusting the event",
    [buy("stale_event_after_refund"), { provider_input: { actor: "external_operator", provider: "stripe", method: "POST", path: "/v1/refunds", body: { charge: "{{step1.actions.0.detail.charge}}" } } }, paid()],
    all(runs([], 2), orderRun([eq("phase", "DONE"), actionKind("workos.grant_access", null, 0), actionKind("slack.post_order", "applied")])),
  ),
  check("withheld_event_swept", "When the payment event never arrives, the missed-event sweep provisions the paid order", [buy("withheld_event_swept"), start("withheld_event_swept", { stage: "sweep", customers: [email("withheld_event_swept")], minAgeMinutes: 0, opsChannel: CHANNEL }, { runId: "withheld-sweep-{{run_id}}" })], all(runs([], 2), runs([eq("phase", "DONE"), granted("applied"), actionKind("stripe.record_provisioned", "applied")]))),
  check("late_event_after_sweep", "An event arriving after the sweep provisioned the order changes nothing", [buy("late_event_after_sweep"), start("late_event_after_sweep", { stage: "sweep", customers: [email("late_event_after_sweep")], minAgeMinutes: 0, opsChannel: CHANNEL }, { runId: "late-sweep-{{run_id}}" }), paid()], all(runs([], 3), runs([granted("applied")]), orderRun([actionKind("workos.grant_access", null, 0)]))),
  check("checkout_retry_charges_once", "Re-running checkout for an order that was already charged charges nothing", [buy("checkout_retry_charges_once"), start("checkout_retry_charges_once", checkout("checkout_retry_charges_once"), { runId: "retry-co-{{run_id}}" })], all(runs([], 2), runs([action("stripe.charge_order", "applied")]), runs([noAction("stripe.charge_order")]))),
  check("large_charge_parked", "A charge above $5,000 waits for approval; nothing is charged", [buy("large_charge_parked", { plan: "business", seats: 250 })], runs([eq("phase", "AWAITING_APPROVAL"), action("stripe.charge_order", "pending_approval")])),
  check("large_charge_stranger_refused", "Someone who is not an approver cannot release a large charge", [buy("large_charge_stranger_refused", { plan: "business", seats: 250 }), command("decide", 1, { decision: "approve", userId: "U_INTERN" }, 403)], runs([eq("phase", "AWAITING_APPROVAL"), action("stripe.charge_order", "pending_approval")])),
  check("large_charge_rejected", "A rejected large charge is never made", [buy("large_charge_rejected", { plan: "business", seats: 250 }), command("decide", 1, { decision: "reject", userId: APPROVER })], runs([eq("phase", "REJECTED"), action("stripe.charge_order", "rejected")])),
  check(
    "large_order_access_reviewed",
    "An approved 250-seat charge is made once, and its payment event parks access for onboarding review",
    [buy("large_order_access_reviewed", { plan: "business", seats: 250 }), command("decide", 1, { decision: "approve", userId: APPROVER }), paid(2)],
    all(runs([], 2), runs([eq("phase", "DONE"), action("stripe.charge_order", "applied", 1, [eq("attempts", 1)])]), orderRun([eq("phase", "AWAITING_APPROVAL"), granted("pending_approval")])),
  ),
  check("duplicate_checkout", "A re-delivered checkout trigger charges once", [buy("duplicate_checkout"), buy("duplicate_checkout")], runs([action("stripe.charge_order", "applied", 1, [eq("attempts", 1)])])),
  check("invalid_input_rejected", "A checkout with a malformed order id is rejected before any agent runs", [start("invalid_input_rejected", checkout("invalid_input_rejected", { orderId: "12345" }), { expectStatus: 400 })], runs([], 0)),
  check("unknown_customer_not_charged", "A checkout for an address with no Stripe customer charges nothing", [buy("unknown_customer_not_charged")], runs([agent("checkout-check", "failed"), noAction("stripe.charge_order")])),
  faultedAtEvent("workos_auth_failure", "With the directory refusing, access and the provisioning record fail; nothing is marked provisioned", "workos", "auth_failure", [orderRun([granted("failed"), actionKind("stripe.record_provisioned", "failed"), eq("outcome", "partial")])]),
  faultedAtEvent("hubspot_rate_limited", "A CRM outage only loses the customer mark; access is still granted and recorded", "hubspot", "rate_limited", [orderRun([actionKind("hubspot.mark_customer", "failed"), granted("applied"), actionKind("stripe.record_provisioned", "applied")])]),
  faultedAtEvent("slack_rate_limited", "Slack rate limiting fails the order post only", "slack", "rate_limited", [orderRun([actionKind("slack.post_order", "failed"), granted("applied")])]),
  check("restart_while_parked", "A large charge parked for approval survives a real runtime restart and is charged once when approved", [buy("restart_while_parked", { plan: "business", seats: 250 }), restart, command("decide", 1, { decision: "approve", userId: APPROVER })], runs([eq("phase", "DONE"), action("stripe.charge_order", "applied", 1, [eq("attempts", 1)])])),
];

/** One Stripe customer per check (the checkout charges its saved card) and the WorkOS organization seats join. */
async function seed(legs, log) {
  const leg = legs.stripe;
  const out = {};
  const orgRes = await fetch(`${legs.workos.base_url}/organizations`, { method: "POST", headers: { authorization: `Bearer ${legs.workos.api_key}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Synthetic Order Org" }) });
  const org = await orgRes.json();
  if (!orgRes.ok || !org.id) throw new Error(`seed organization → ${orgRes.status} ${JSON.stringify(org).slice(0, 300)}`);
  for (const c of checks) for (const a of c.actions ?? []) if (a.body?.input?.organizationId === ORG) a.body.input.organizationId = org.id;
  out.organization = org.id;
  for (const c of checks) {
    if (c.id === "unknown_customer_not_charged" || c.id === "unknown_payment_ignored") continue;
    const res = await fetch(`${leg.base_url}/v1/customers`, { method: "POST", headers: { authorization: `Bearer ${leg.api_key}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: email(c.id), name: "Pat Buyer" }).toString() });
    const body = await res.json();
    if (!res.ok || !body.id) throw new Error(`seed customer for ${c.id} → ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
    out[c.id] = body.id;
  }
  log("seed", Object.keys(out).length, "customers");
  return out;
}

export default {
  workflow: "paid-order-provisioning",
  providers: ["stripe", "workos", "hubspot", "gmail", "slack"],
  seed,
  applicationConfig: { event_destinations: { stripe: "/webhooks/stripe" } },
  envMapping: { FETCHSANDBOX_STRIPE_WEBHOOK_SECRET: "STRIPE_WEBHOOK_SECRET" },
  context: {
    goal: "Prove the paid-order-provisioning AgentCore runtime: checkout charges a saved card on the Stripe twin; a signed payment_intent.succeeded delivered to the real handler POST /webhooks/stripe starts provisioning (WorkOS user + membership, HubSpot customer, Gmail welcome draft, provisioning record on the payment); the runtime re-reads Stripe instead of trusting the event; a sweep recovers orders whose event never arrived.",
    workflow: "POST /invocations {action:start, input.stage:checkout|sweep}; POST /webhooks/stripe with a Stripe-Signature header (the same request can arrive through /invocations as an envelope on AgentCore). Every delivery of one order maps to run order-<orderId>. GET /verify/runs/{run}/cases/{case}/runs reads saved run state; webhook-started runs inherit the checkout run's labels.",
    entry_points: ["POST /invocations", "POST /webhooks/stripe"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline", "payment_event_provisions"],
    identity_and_access: ["large_charge_stranger_refused", "unknown_payment_ignored", "unknown_customer_not_charged"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: ["large_charge_parked", "large_order_access_reviewed"],
    duplicate_replay: ["exact_replay_once", "duplicate_checkout", "checkout_retry_charges_once"],
    concurrency: ["concurrent_deliveries_once"],
    ordering_and_stale_events: ["stale_event_after_refund", "late_event_after_sweep"],
    delayed_or_missing_events: ["withheld_event_swept"],
    provider_auth_and_scopes: ["workos_auth_failure"],
    rate_limit_server_error_timeout: ["hubspot_rate_limited", "slack_rate_limited"],
    accepted_effect_response_loss: "Checkout looks up its own payment (metadata acme_order) before charging, because the Stripe twin ignores Idempotency-Key; covered by checkout_retry_charges_once and local tests. The partner-payout-run contract measures response loss directly.",
    partial_effects_and_recovery: ["workos_auth_failure", "hubspot_rate_limited"],
    restart_and_durability: ["restart_while_parked"],
    reconciliation: ["provisioning_reconciled"],
    cancellation_refund_entitlements: ["stale_event_after_refund", "large_charge_rejected"],
    data_and_privacy_boundaries: "Run summaries carry a user hash; the welcome email is a draft. Invalid, mutated and expired signatures are refused before any read (local tests; the verifier signs every event it sends).",
    cleanup_and_isolation: ["payment_event_provisions", "concurrent_deliveries_once"],
  },
  evidence: ["acme-ops/src/workflows/paid-order-provisioning.ts", "acme-ops/src/kit/webhooks.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/providers/{stripe,hubspot,google,slack,work}.ts"],
};
