import { action, actionKind, agent, all, check, command, eq, runs, start } from "./lib.mjs";

// Executable expectations for a month-end close (Kit v2: per-journal approval
// signals, a day-2 reminder timer, sign-off before the period locks, audit).
// seed() tries to give the twins a closing month the way a real account has
// one: Stripe payouts with fees, and a Plaid sandbox bank link
// (/sandbox/public_token/create → /item/public_token/exchange) whose
// transactions show the payouts landing. Anything a twin refuses is recorded,
// not thrown. The ERP (NetSuite) has no twin: journals and the period lock are
// executable expectations here, measured as gaps.
const CLOSE = "C0FINANCE01";
const BANK = "BANK_TOKEN";
const input = (over = {}) => ({ period: "2026-10", periodName: "Oct 2026", bankAccessToken: "access-sandbox-placeholder", closeChannel: CLOSE, approvers: ["U_CONTROLLER"], ...over });
const close = (c, over) => start(c, input(over));
const signal = (id, value = "approve") => command("signal", 1, { actionId: id, value, userId: "U_CONTROLLER" });

export const checks = [
  check("baseline", "A close run starts and posts its status", [close("baseline")], runs([actionKind("slack.close_status", null, 1)])),
  check("payouts_read", "October's Stripe payouts and their fees are read", [close("payouts_read")], runs([agent("stripe-payouts", "ok")])),
  check("bank_feed_read", "The operating account's transactions are read from the bank feed (Plaid)", [close("bank_feed_read")], runs([agent("bank-deposits", "ok")])),
  check("payouts_reconciled", "Every payout is matched to a bank deposit within three days", [close("payouts_reconciled")], runs([eq("output.mode", "closing"), eq("output.exceptions", 0)])),
  check("fee_journal_on_approval", "The Stripe-fee journal posts when the controller approves it", [close("fee_journal_on_approval"), signal("netsuite.journal:fees:2026-10")], runs([action("netsuite.journal:fees:2026-10", "applied")])),
  check("accrual_reverses_next_period", "The received-not-billed accrual is proposed with a reversal on the first day of the next period", [close("accrual_reverses_next_period")], runs([action("netsuite.journal:accrual:2026-10", "awaiting_signal")])),
  check("signoff_locks_period", "After the journals settle, the controller's sign-off locks the period", [close("signoff_locks_period"), signal("netsuite.journal:fees:2026-10"), signal("netsuite.journal:accrual:2026-10"), signal("controller.signoff:2026-10")], runs([action("netsuite.lock_period:2026-10", "applied")])),
  check("reminder_while_open", "On day 2 the controller is reminded of journals still waiting (needs clock control)", [close("reminder_while_open"), { method: "POST", path: "/invocations", body: { action: "tick" }, expect_status: 200 }], runs([action("slack.remind:2026-10", "applied")])),
  check("stripe_unreadable_blocks", "Without Stripe the close is blocked and nothing locks", [close("stripe_unreadable_blocks")], all(runs([agent("stripe-payouts", "failed"), eq("output.mode", "blocked"), actionKind("netsuite.lock_period", null, 0)])), { fault: { provider: "stripe", scenario: "auth_failure", evidence: "refusal" } }),
  check("invalid_input_rejected", "A malformed period is rejected before any agent runs", [start("invalid_input_rejected", input({ period: "Oct-2026" }), { expectStatus: 400 })], runs([], 0)),
];

async function seed(legs, log) {
  const trail = [];
  const stripe = async (path, form) => {
    const res = await fetch(`${legs.stripe.base_url}${path}`, { method: "POST", headers: { authorization: `Bearer ${legs.stripe.api_key}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
    const body = await res.json().catch(() => ({}));
    trail.push(`stripe ${path} → ${res.status}${body.error ? ` ${body.error.message ?? body.error.type}` : ""}`);
    return body;
  };
  const plaid = async (path, json) => {
    const res = await fetch(`${legs.plaid.base_url}${path}`, { method: "POST", headers: { authorization: `Bearer ${legs.plaid.api_key}`, "content-type": "application/json" }, body: JSON.stringify(json) });
    const body = await res.json().catch(() => ({}));
    trail.push(`plaid ${path} → ${res.status}${body.error_code ? ` ${body.error_code}` : ""}`);
    return body;
  };
  // A charge so the account has a balance, then two payouts.
  const cus = await stripe("/v1/customers", { email: "close@acme.example" });
  await stripe("/v1/payment_intents", { amount: "206000", currency: "usd", customer: cus.id ?? "", confirm: "true", payment_method: "pm_card_visa" });
  await stripe("/v1/payouts", { amount: "120000", currency: "usd" });
  await stripe("/v1/payouts", { amount: "80000", currency: "usd" });
  const pub = await plaid("/sandbox/public_token/create", { institution_id: "ins_109508", initial_products: ["transactions"] });
  const ex = pub.public_token ? await plaid("/item/public_token/exchange", { public_token: pub.public_token }) : {};
  const token = ex.access_token ?? null;
  if (token) {
    const tx = await plaid("/transactions/get", { access_token: token, start_date: "2026-10-01", end_date: "2026-11-03" });
    trail.push(`plaid transactions: ${tx.transactions?.length ?? 0}, stripe deposits: ${(tx.transactions ?? []).filter((t) => /stripe/i.test(t.name ?? "")).length}`);
    for (const c of checks) for (const a of c.actions ?? []) if (a.body?.input?.bankAccessToken) a.body.input.bankAccessToken = token;
  }
  log("seed", trail.join("; "));
  return { trail, [BANK]: token };
}

export default {
  workflow: "month-end-close",
  providers: ["stripe", "plaid", "asana", "slack"],
  seed,
  context: {
    goal: "Prove the month-end-close AgentCore runtime: period end → parallel Stripe payouts with fees, Plaid bank transactions and NetSuite received-not-billed receipts → payout/deposit reconciliation (exceptions to Asana), Stripe-fee and auto-reversing accrual journals posted only on a controller's approval, a day-2 reminder, and a period lock only after the controller's sign-off; every step hash-chained.",
    workflow: "POST /invocations {action:start}; {action:signal} approves journals and signs off; {action:tick} fires the reminder; {action:evidence}. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: "Only controllers approve journals and sign off (Kit v2 signal rules).",
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: ["payouts_reconciled", "fee_journal_on_approval"],
    duplicate_replay: "Journals carry an external id per period and are never posted twice (local tests).",
    concurrency: "Signals are compare-and-swap on the run.",
    ordering_and_stale_events: ["signoff_locks_period"],
    delayed_or_missing_events: ["reminder_while_open"],
    provider_auth_and_scopes: ["stripe_unreadable_blocks"],
    rate_limit_server_error_timeout: ["stripe_unreadable_blocks"],
    accepted_effect_response_loss: "Journal creation looks up its external id first.",
    partial_effects_and_recovery: "A rejected sign-off leaves the period open (local tests).",
    restart_and_durability: "Signals and timers survive restarts (Kit v2 tests).",
    reconciliation: ["payouts_reconciled"],
    cancellation_refund_entitlements: ["accrual_reverses_next_period"],
    data_and_privacy_boundaries: "Only amounts, dates and ids leave the systems.",
    cleanup_and_isolation: ["baseline"],
  },
  evidence: ["acme-ops/src/workflows/month-end-close.ts", "acme-ops/test/month-end-close.test.ts"],
};
