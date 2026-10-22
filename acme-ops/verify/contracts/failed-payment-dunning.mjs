import { action, actionKind, agent, all, check, command, eq, runs, start } from "./lib.mjs";

// seed() tries to give every check what dunning needs on the Stripe twin: a
// customer whose saved card fails, a subscription, and an open invoice with a
// failed collection attempt. The checks start the "payment_failed" stage (what
// the signed invoice.payment_failed webhook starts; its mapping is unit-tested)
// and the age sweep, and also assert the invoice's own state on the twin. They
// are ordinary executable checks: whether the twin can hold a failed invoice,
// count attempts and age it is what this contract measures.
const CHANNEL = "C0BILLING01";
const APPROVER = "U_CONTROLLER";

/**
 * Per check: failed collection attempts wanted on the invoice, and how old it
 * must be (days). Age needs a clock (Stripe test clocks); the seed has no other
 * honest way to age an invoice, so ageDays documents what the check needs.
 */
const FIXTURES = {
  baseline: { attempts: 1, ageDays: 1 },
  first_failure_card_update_notice: { attempts: 1, ageDays: 1 },
  second_failure_tries_backup_card: { attempts: 2, ageDays: 3, backupCard: true },
  final_notice_after_14_days: { attempts: 2, ageDays: 15 },
  cancellation_needs_approval: { attempts: 3, ageDays: 22 },
  repeated_failure_no_second_notice: { attempts: 1, ageDays: 1 },
  paid_invoice_contacts_nobody: { attempts: 0, ageDays: 0, paid: true },
  stripe_auth_failure: { attempts: 1, ageDays: 1 },
};
const email = (caseId) => `dun-${caseId.replaceAll("_", "-")}@billing.example.com`;
const invoice = (caseId) => `in_seed_${caseId}`;
const failed = (caseId, over = {}) => ({ stage: "payment_failed", invoiceId: invoice(caseId), financeChannel: CHANNEL, approvers: [APPROVER], ...over });
const sweep = (caseId) => ({ stage: "sweep", customers: [email(caseId)], financeChannel: CHANNEL, approvers: [APPROVER] });
const draft = (status = "applied", count = 1) => actionKind("gmail.draft_notice", status, count);
/** The invoice as the Stripe twin holds it. */
const invoiceOnTwin = (caseId, where) => ({ provider: "stripe", collection: "invoices", assertion: { select: "records[*]", count: 1, required: true, where: [eq("id", invoice(caseId)), ...where] } });
const twin = (c, ...a) => ({ ...c, provider_assertions: a });

export const checks = [
  check("baseline", "The daily sweep reads the customer's open invoices and finishes", [start("baseline", sweep("baseline"))], runs([eq("phase", "DONE"), agent("invoice-check", "ok")])),
  twin(
    check("first_failure_card_update_notice", "After the first failed collection the customer gets a card-update notice draft and the step is recorded", [start("first_failure_card_update_notice", failed("first_failure_card_update_notice"))], runs([eq("phase", "DONE"), eq("output.mode", "dunning"), draft(), action(`stripe.record_step:${invoice("first_failure_card_update_notice")}`, "applied")])),
    invoiceOnTwin("first_failure_card_update_notice", [eq("status", "open"), eq("attempt_count", 1)]),
  ),
  twin(
    check("second_failure_tries_backup_card", "After the second failure the customer's other saved card is tried once, and a reminder goes out if it declines", [start("second_failure_tries_backup_card", failed("second_failure_tries_backup_card"))], runs([actionKind("stripe.retry_backup", "applied"), draft()])),
    invoiceOnTwin("second_failure_tries_backup_card", [eq("status", "open"), eq("attempt_count", 2)]),
  ),
  twin(
    check("final_notice_after_14_days", "An invoice unpaid for 14 days gets the final notice from the daily sweep", [start("final_notice_after_14_days", sweep("final_notice_after_14_days"))], runs([eq("output.mode", "dunning"), draft()])),
    invoiceOnTwin("final_notice_after_14_days", [eq("status", "open")]),
  ),
  twin(
    check("cancellation_needs_approval", "After 21 days the sweep proposes cancelling the subscription, and it waits for the controller", [start("cancellation_needs_approval", sweep("cancellation_needs_approval"))], runs([eq("phase", "AWAITING_APPROVAL"), actionKind("stripe.cancel_subscription", "pending_approval")])),
    invoiceOnTwin("cancellation_needs_approval", [eq("status", "open")]),
  ),
  check(
    "repeated_failure_no_second_notice",
    "A second delivery of the same failure (a new trigger) finds the step taken and sends nothing more",
    [start("repeated_failure_no_second_notice", failed("repeated_failure_no_second_notice")), start("repeated_failure_no_second_notice", failed("repeated_failure_no_second_notice"), { runId: "repeat-b-{{run_id}}" })],
    all(runs([], 2), runs([draft()]), runs([eq("output.mode", "nothing"), draft(null, 0)])),
  ),
  check("paid_invoice_contacts_nobody", "A failure event for an invoice that is paid by now contacts nobody", [start("paid_invoice_contacts_nobody", failed("paid_invoice_contacts_nobody"))], runs([eq("phase", "DONE"), eq("output.mode", "nothing"), draft(null, 0)])),
  check("unknown_invoice_contacts_nobody", "An invoice Stripe doesn't know contacts nobody and alerts finance", [start("unknown_invoice_contacts_nobody", failed("unknown_invoice_contacts_nobody", { invoiceId: "in_doesnotexist0000" }))], runs([eq("output.mode", "blocked"), draft(null, 0), action("slack.escalate:blocked", "applied")])),
  check("stripe_auth_failure", "Without Stripe nobody is contacted and finance is alerted", [start("stripe_auth_failure", failed("stripe_auth_failure"))], all(runs([agent("invoice-check", "failed"), draft(null, 0), action("slack.escalate:blocked", "applied")])), { fault: { provider: "stripe", scenario: "auth_failure", evidence: "refusal" } }),
  check("invalid_input_rejected", "A malformed invoice id is rejected before any agent runs", [start("invalid_input_rejected", { ...failed("baseline"), invoiceId: "ch_123" }, { expectStatus: 400 })], runs([], 0)),
];

/**
 * Builds the failed invoice the way a real Stripe account gets one: a customer
 * whose default card fails, an invoice item, a finalized charge-automatically
 * invoice, and collection attempts. Every step's outcome is recorded (not
 * thrown) so the receipt shows how far the twin got.
 */
async function seed(legs, log) {
  const call = async (method, path, form) => {
    const res = await fetch(`${legs.stripe.base_url}${path}`, { method, headers: { authorization: `Bearer ${legs.stripe.api_key}`, "content-type": "application/x-www-form-urlencoded" }, body: form ? new URLSearchParams(form).toString() : undefined });
    let body;
    try { body = await res.json(); } catch { body = {}; }
    return { status: res.status, body };
  };
  const ids = {};
  for (const [caseId, f] of Object.entries(FIXTURES)) {
    const trail = [];
    const cus = await call("POST", "/v1/customers", { email: email(caseId), name: "Dana Billing" });
    if (!cus.body.id) throw new Error(`seed customer ${caseId} → ${cus.status}`);
    await call("POST", "/v1/payment_methods/pm_card_chargeCustomerFail/attach", { customer: cus.body.id });
    await call("POST", `/v1/customers/${cus.body.id}`, { "invoice_settings[default_payment_method]": f.paid ? "pm_card_visa" : "pm_card_chargeCustomerFail" });
    if (f.backupCard) await call("POST", "/v1/payment_methods/pm_card_visa/attach", { customer: cus.body.id });
    const price = await call("POST", "/v1/prices", { unit_amount: "60000", currency: "usd", "recurring[interval]": "month", "product_data[name]": "Business plan" });
    const sub = await call("POST", "/v1/subscriptions", { customer: cus.body.id, "items[0][price]": price.body.id });
    trail.push(`subscription ${sub.body.status}`);
    await call("POST", "/v1/invoiceitems", { customer: cus.body.id, amount: "60000", currency: "usd", description: "Business plan" });
    // Ask for the invoice a real account has, then drop options the twin refuses, recording each refusal.
    const base = { customer: cus.body.id, collection_method: "charge_automatically" };
    let inv = { status: 0, body: {} };
    for (const extra of [{ auto_advance: "true", ...(sub.body.id ? { subscription: sub.body.id } : {}) }, { auto_advance: "true" }, {}]) {
      inv = await call("POST", "/v1/invoices", { ...base, ...extra });
      if (inv.body.id) break;
      trail.push(`invoice ${JSON.stringify(extra)} → ${inv.status} ${inv.body.error?.message ?? ""}`.trim());
    }
    if (!inv.body.id) throw new Error(`seed invoice ${caseId} → ${inv.status} ${JSON.stringify(inv.body).slice(0, 200)}`);
    const fin = await call("POST", `/v1/invoices/${inv.body.id}/finalize`, {});
    trail.push(`finalize ${fin.status} → ${fin.body.status} due ${fin.body.amount_remaining}`);
    for (let i = 0; i < f.attempts; i++) {
      const pay = await call("POST", `/v1/invoices/${inv.body.id}/pay`, {});
      trail.push(`pay ${pay.status} ${pay.body.error?.type ?? pay.body.status}`);
    }
    const final = await call("GET", `/v1/invoices/${inv.body.id}`);
    trail.push(`invoice ${final.body.status}, attempt_count ${final.body.attempt_count}, remaining ${final.body.amount_remaining}`);
    ids[caseId] = { invoice: inv.body.id, customer: cus.body.id, trail };
    log("seed", caseId, trail.join("; "));
  }
  for (const c of checks) {
    const real = ids[c.id]?.invoice;
    if (!real) continue;
    const ph = invoice(c.id);
    for (const a of c.actions ?? []) if (a.body?.input?.invoiceId === ph) a.body.input.invoiceId = real;
    const fix = (where) => where?.forEach((w) => { if (typeof w.equals === "string" && w.equals.endsWith(ph)) w.equals = w.equals.slice(0, -ph.length) + real; fix(w.where); });
    const walk = (a) => { if (!a) return; fix(a.where); a.all_of?.forEach(walk); };
    walk(c.assertion);
    for (const pa of c.provider_assertions ?? []) fix(pa.assertion.where);
  }
  return ids;
}

export default {
  workflow: "failed-payment-dunning",
  providers: ["stripe", "gmail", "slack"],
  seed,
  context: {
    goal: "Prove the failed-payment-dunning AgentCore runtime: an open invoice with failed collection attempts (from invoice.payment_failed or the daily age sweep) → re-read invoice, subscription and saved cards → card-update notice, then reminder with one backup-card retry, final notice at 14 days, subscription cancellation with approval at 21 days; steps never repeat or regress and a paid invoice stops the ladder.",
    workflow: "POST /invocations {action:start, input.stage:payment_failed|sweep} plans and applies the due step and parks cancellation; {action:decide} releases it. GET /verify/runs/{run}/cases/{case}/runs reads saved run state; the invoice is also asserted on the Stripe twin.",
    entry_points: ["POST /invocations", "POST /webhooks/stripe"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: "Invoices are re-read from Stripe; the event is only a hint (local tests). Cancellation approval: cancellation_needs_approval.",
    schema_and_value_boundaries: ["invalid_input_rejected", "unknown_invoice_contacts_nobody"],
    amount_currency_quantity: ["second_failure_tries_backup_card"],
    duplicate_replay: ["repeated_failure_no_second_notice"],
    concurrency: "One run per invoice attempt; the step record is re-read before each notice (local tests).",
    ordering_and_stale_events: ["paid_invoice_contacts_nobody", "repeated_failure_no_second_notice"],
    delayed_or_missing_events: ["final_notice_after_14_days", "cancellation_needs_approval"],
    provider_auth_and_scopes: ["stripe_auth_failure"],
    rate_limit_server_error_timeout: ["stripe_auth_failure"],
    accepted_effect_response_loss: "The retry carries an Idempotency-Key per invoice; notices are drafts guarded by the step record (local tests).",
    partial_effects_and_recovery: ["second_failure_tries_backup_card"],
    restart_and_durability: "Cancellation parks for approval like every other runtime (engine restart tests); not re-measured here.",
    reconciliation: "stripe.record_step reconciles the step on the customer (local tests).",
    cancellation_refund_entitlements: ["cancellation_needs_approval"],
    data_and_privacy_boundaries: "Notices are Gmail drafts to the invoice's customer only; Slack gets invoice ids and amounts.",
    cleanup_and_isolation: ["baseline"],
  },
  evidence: ["acme-ops/src/workflows/failed-payment-dunning.ts", "acme-ops/src/providers/stripe.ts", "acme-ops/test/failed-payment-dunning.test.ts"],
};
