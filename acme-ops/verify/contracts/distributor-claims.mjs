import { action, actionKind, agent, all, blocked, check, command, eq, restart, runs, start, startAgain } from "./lib.mjs";

// Twin seed: alice@acmecorp.com (the distributor here) has PAID invoice
// in_3QaT2bVwXy5zA6Bc7D ($245); dev@startupxyz.io has OPEN invoice
// in_7EfG8hIjKl9mN0Op1Q. Pro list price is $49/unit.
//   c1: 2 units sold at $41.65 (15% off, within the 20% agreement) → approve, $14.70
//   c2: 2 units claimed at $24.50 (50% off) → partial, capped at 20% → $19.60
//   c3: dev's open invoice → deny
// Paying the credit changes the distributor's balance, so the approving check runs last.
const CHANNEL = "G0PRIVATE01";
const APPROVER = "U_CHANNEL_FINANCE";
const PAID = "in_3QaT2bVwXy5zA6Bc7D";
const claim = (claimId, over) => ({ claimId, invoiceId: PAID, productId: "prod_SaaS_ProPlan", qty: 2, claimedUnitPriceMinor: 4165, endCustomer: "Initech Utilities", ...over });
const claims = [claim("C-1"), claim("C-2", { claimedUnitPriceMinor: 2450 }), claim("C-3", { invoiceId: "in_7EfG8hIjKl9mN0Op1Q" })];
const input = (over = {}) => ({ distributorEmail: "alice@acmecorp.com", claims, agreement: { maxDiscountPct: 20 }, financeChannel: CHANNEL, approvers: [APPROVER], ...over });
const parked = [eq("phase", "AWAITING_APPROVAL")];

function faulted(id, name, provider, scenario, assertions) {
  return check(id, name, [start(id, input())], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });
}

export const checks = [
  check("baseline", "Claims are validated (approve, partial, deny), the decisions are posted and drafted, and the credit waits for approval", [start("baseline", input())], all(runs([...parked, eq("outcome", "ok")]), runs([action("slack.post_claims_summary", "applied")]), runs([action("gmail.draft_claim_decisions", "applied")]), runs([actionKind("stripe.credit_claims", "pending_approval", 1)]))),
  check("all_denied_pays_nothing", "A batch with only invalid claims proposes no credit", [start("all_denied_pays_nothing", input({ claims: [claims[2]] }))], all(runs([eq("phase", "DONE")]), runs([actionKind("stripe.credit_claims", null, 0)]), runs([action("gmail.draft_claim_decisions", "applied")]))),
  check("approve_by_stranger_refused", "A non-approver cannot pay a claim", [start("approve_by_stranger_refused", input()), command("decide", 1, { decision: "approve", userId: "U_DISTI_REP" }, 403)], all(runs(parked), runs([actionKind("stripe.credit_claims", "pending_approval", 1)]))),
  check("reject", "Rejecting pays nothing", [start("reject", input()), command("decide", 1, { decision: "reject", userId: APPROVER })], all(runs([eq("phase", "REJECTED")]), runs([actionKind("stripe.credit_claims", "rejected", 1)]))),
  check("invalid_input_rejected", "Two claims with the same id are rejected before any agent runs", [start("invalid_input_rejected", input({ claims: [claims[0], claims[0]] }), { expectStatus: 400 })], runs([], 0)),
  check("duplicate_start", "A re-submitted batch does not post or draft twice", [start("duplicate_start", input()), startAgain("duplicate_start", input())], all(runs([action("slack.post_claims_summary", "applied", 1, [eq("attempts", 1)])]))),
  check("concurrent_start", "Four more simultaneous submissions create one run", [start("concurrent_start", input()), startAgain("concurrent_start", input(), 1, 4)], all(runs([action("gmail.draft_claim_decisions", "applied", 1, [eq("attempts", 1)])]))),
  faulted("stripe_auth_failure", "If Stripe can't be read, no claim is decided or paid", "stripe", "auth_failure", [agent("invoice-ledger", "failed"), { select: "actions[*]", count: 0, required: true }]),
  faulted("hubspot_auth_failure", "HubSpot is context only: claims are still decided", "hubspot", "auth_failure", [agent("distributor-account", "failed"), actionKind("stripe.credit_claims", "pending_approval", 1)]),
  faulted("slack_channel_not_found", "Slack failure fails the summary only", "slack", "channel_not_found", [action("slack.post_claims_summary", "failed"), actionKind("stripe.credit_claims", "pending_approval", 1), eq("outcome", "partial")]),
  check("restart_while_parked", "A pending credit survives a real runtime restart; the decision taken afterwards is honored", [start("restart_while_parked", input()), restart, command("decide", 1, { decision: "reject", userId: APPROVER })], all(runs([eq("phase", "REJECTED")]), runs([actionKind("stripe.credit_claims", "rejected", 1)]))),
  check("approve_and_reconcile", "The approved credit is posted to the distributor's Stripe balance and read back", [start("approve_and_reconcile", input()), command("decide", 1, { decision: "approve", userId: APPROVER }), command("reconcile", 1)], all(runs([eq("phase", "DONE")]), runs([actionKind("stripe.credit_claims", "applied", 1, [eq("reconciled", "match")])]))),
  blocked("invoice_line_validation", "Each claim's product and quantity are checked against the invoice's line items", "setup_missing", "Stripe twin invoices carry no line items (GET /v1/invoices/{id} lines.data = [] and /lines returns []), so claims are only checked against the invoice's paid amount (invoiceCheck=amount_only).", ["acme-ops/src/workflows/distributor-claims.ts decideClaims()", "Stripe twin GET /v1/invoices/in_3QaT2bVwXy5zA6Bc7D/lines → {data:[]}"]),
];

export default {
  workflow: "distributor-claims",
  providers: ["stripe", "hubspot", "gmail", "slack"],
  context: {
    goal: "Prove the distributor-claims AgentCore runtime: Stripe invoices ‖ price list ‖ HubSpot → claim decisions, summary, decisions draft, gated balance credit with read-back.",
    workflow: "POST /invocations {action:start} validates each claim against the distributor's paid invoice, list price and agreement, posts and drafts the decisions and parks the credit; {action:decide} pays or withholds; {action:reconcile} re-reads the balance transaction. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["approve_by_stranger_refused"],
    schema_and_value_boundaries: ["invalid_input_rejected", "all_denied_pays_nothing"],
    amount_currency_quantity: ["baseline", "approve_and_reconcile", "invoice_line_validation"],
    duplicate_replay: ["duplicate_start"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: "A batch is decided on a point-in-time read; already-credited claim ids are refused.",
    delayed_or_missing_events: "No inbound provider events.",
    provider_auth_and_scopes: ["stripe_auth_failure", "hubspot_auth_failure"],
    rate_limit_server_error_timeout: "Exercised by other contracts through the shared retry path.",
    accepted_effect_response_loss: "Covered by side-effect claims in local tests.",
    partial_effects_and_recovery: ["slack_channel_not_found"],
    restart_and_durability: ["restart_while_parked"],
    reconciliation: ["approve_and_reconcile"],
    cancellation_refund_entitlements: ["reject", "all_denied_pays_nothing"],
    data_and_privacy_boundaries: "Decisions go to the private finance channel and a draft for review.",
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: ["acme-ops/src/workflows/distributor-claims.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/providers/{stripe,hubspot,google,slack}.ts"],
};
