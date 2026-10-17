import { action, agent, all, blocked, check, command, eq, noAction, restart, runs, start, startAgain } from "./lib.mjs";

// Twin seed catalog: "Pro Plan" (prod_SaaS_ProPlan, $49/month) and "Enterprise Plan"
// (prod_SaaS_EntPlan, $1,999/year). Each check uses its own buyer.
const CHANNEL = "C0GENERAL01";
const APPROVER = "U_RVP_SALES";
const rfq = (caseId, over = {}) => ({
  buyer: { email: `rfq-${caseId.replaceAll("_", "-")}@globex.test`, firstname: "Hank", lastname: "Scorpio" },
  company: "Globex",
  lines: [{ product: "Pro Plan", quantity: 20 }],
  requestedDiscountPct: 20,
  salesChannel: CHANNEL,
  approvers: [APPROVER],
  ...over,
});
const parked = [eq("phase", "AWAITING_APPROVAL")];

function faulted(id, name, provider, scenario, assertions, input = rfq(id)) {
  return check(id, name, [start(id, input)], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });
}

export const checks = [
  check("baseline", "A small-discount RFQ is priced from the catalog, quoted, finalized and covered automatically", [start("baseline", rfq("baseline", { requestedDiscountPct: 5 }))], all(runs([eq("phase", "DONE"), eq("outcome", "ok")]), runs([action("hubspot.upsert_buyer", "applied")]), runs([action("stripe.ensure_customer", "applied")]), runs([action("stripe.draft_quote", "applied")]), runs([action("stripe.finalize_quote", "applied")]), runs([action("gmail.draft_quote_cover", "applied")]), runs([action("slack.post_rfq", "applied")]))),
  check("approval_discount_parks", "A 20% discount drafts the quote but parks finalizing and the cover email for approval", [start("approval_discount_parks", rfq("approval_discount_parks"))], all(runs(parked), runs([action("stripe.draft_quote", "applied")]), runs([action("stripe.finalize_quote", "pending_approval")]), runs([action("gmail.draft_quote_cover", "pending_approval")]))),
  check("approve_and_reconcile", "Approval finalizes the quote once and Stripe reads it back as finalized", [start("approve_and_reconcile", rfq("approve_and_reconcile")), command("decide", 1, { decision: "approve", userId: APPROVER }), command("reconcile", 1)], all(runs([eq("phase", "DONE")]), runs([action("stripe.finalize_quote", "applied", 1, [eq("reconciled", "match")])]), runs([action("gmail.draft_quote_cover", "applied")]))),
  check("approve_by_stranger_refused", "A non-approver cannot release a discounted quote", [start("approve_by_stranger_refused", rfq("approve_by_stranger_refused")), command("decide", 1, { decision: "approve", userId: "U_SDR" }, 403)], all(runs(parked), runs([action("stripe.finalize_quote", "pending_approval")]))),
  check("reject", "Rejecting leaves the quote in draft and sends nothing", [start("reject", rfq("reject")), command("decide", 1, { decision: "reject", userId: APPROVER })], all(runs([eq("phase", "REJECTED")]), runs([action("stripe.finalize_quote", "rejected")]), runs([action("gmail.draft_quote_cover", "rejected")]))),
  check("discount_over_policy_declined", "A 40% request is declined in code: quoted at list price, finalized without approval", [start("discount_over_policy_declined", rfq("declined", { requestedDiscountPct: 40 }))], all(runs([eq("phase", "DONE")]), runs([action("stripe.finalize_quote", "applied")]))),
  check("unknown_part_manual_pricing", "An unknown part creates no quote; Sales is asked to price it", [start("unknown_part_manual_pricing", rfq("unknown_part", { lines: [{ product: "Flux Capacitor", quantity: 2 }] }))], all(runs([eq("phase", "DONE")]), runs([noAction("stripe.draft_quote")]), runs([noAction("stripe.ensure_customer")]), runs([action("slack.post_rfq", "applied")]))),
  check("mixed_terms_manual_pricing", "Monthly and yearly lines in one RFQ go to Sales instead of a quote Stripe would reject", [start("mixed_terms_manual_pricing", rfq("mixed_terms", { lines: [{ product: "Pro Plan", quantity: 5 }, { product: "Enterprise Plan", quantity: 1 }] }))], all(runs([eq("phase", "DONE")]), runs([noAction("stripe.draft_quote")]), runs([action("slack.post_rfq", "applied")]))),
  check("duplicate_start", "A re-delivered RFQ creates one quote", [start("duplicate_start", rfq("duplicate_start", { requestedDiscountPct: 0 })), startAgain("duplicate_start", rfq("duplicate_start", { requestedDiscountPct: 0 }))], all(runs([action("stripe.draft_quote", "applied", 1, [eq("attempts", 1)])]))),
  check("concurrent_start", "Four more simultaneous deliveries create one Stripe customer and one quote", [start("concurrent_start", rfq("concurrent_start", { requestedDiscountPct: 0 })), startAgain("concurrent_start", rfq("concurrent_start", { requestedDiscountPct: 0 }), 1, 4)], all(runs([action("stripe.ensure_customer", "applied", 1, [eq("attempts", 1)])]), runs([action("stripe.draft_quote", "applied", 1, [eq("attempts", 1)])]))),
  check("invalid_input_rejected", "A zero quantity is rejected before any agent runs", [start("invalid_input_rejected", rfq("invalid", { lines: [{ product: "Pro Plan", quantity: 0 }] }), { expectStatus: 400 })], runs([], 0)),
  faulted("stripe_rate_limited", "Stripe rate limiting past retries: no quote is attempted, Sales is told to price manually", "stripe", "rate_limited", [agent("catalog-pricing", "failed"), noAction("stripe.draft_quote"), action("slack.post_rfq", "applied")]),
  faulted("hubspot_auth_failure", "HubSpot auth failure skips the CRM update; quoting continues", "hubspot", "auth_failure", [agent("crm-lookup", "failed"), noAction("hubspot.upsert_buyer"), action("stripe.draft_quote", "applied")]),
  check("restart_while_parked", "A discounted quote parked for approval survives a runtime restart and is finalized once approved", [start("restart_while_parked", rfq("restart")), restart, command("decide", 1, { decision: "approve", userId: APPROVER })], all(runs([eq("phase", "DONE")]), runs([action("stripe.finalize_quote", "applied", 1, [eq("attempts", 1)])]))),
  blocked("discount_as_stripe_coupon", "The approved discount is applied on the quote as a Stripe coupon", "setup_missing", "The Stripe twin rejects discounts on quotes (501 unsupported_checkout_option), so the discount is recorded in quote metadata and applied at invoicing; the coupon path is not exercised.", ["acme-ops/src/workflows/rfq-quote.ts stripe.draft_quote", "POST /v1/quotes with discounts[0][coupon] → 501 on the twin"]),
  blocked("salesforce_cpq", "Quotes are created in ACME's CPQ / Salesforce opportunity", "setup_missing", "No Salesforce twin in FetchSandbox; ACME's quote is a Stripe quote and the CRM is HubSpot.", ["validate_integration providers:[salesforce] → 'Unknown providers: salesforce'"]),
];

export default {
  workflow: "rfq-quote",
  providers: ["stripe", "hubspot", "gmail", "slack"],
  context: {
    goal: "Prove the rfq-quote AgentCore runtime: RFQ → parallel Stripe catalog pricing, Stripe customer and HubSpot lookups → CRM update, customer, draft quote, Slack; discount policy decides whether finalizing waits for approval.",
    workflow: "POST /invocations {action:start} prices the RFQ and applies auto actions; approval-level discounts park finalize + cover email for {action:decide}; {action:reconcile} re-reads the quote.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["approve_by_stranger_refused"],
    schema_and_value_boundaries: ["invalid_input_rejected", "unknown_part_manual_pricing", "mixed_terms_manual_pricing"],
    amount_currency_quantity: ["discount_over_policy_declined", "approval_discount_parks", "discount_as_stripe_coupon"],
    duplicate_replay: ["duplicate_start"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: "One trigger per RFQ; prices are read at run start.",
    delayed_or_missing_events: "No inbound provider events.",
    provider_auth_and_scopes: ["hubspot_auth_failure"],
    rate_limit_server_error_timeout: ["stripe_rate_limited"],
    accepted_effect_response_loss: "Covered by side-effect claims in local tests.",
    partial_effects_and_recovery: ["hubspot_auth_failure"],
    restart_and_durability: ["restart_while_parked"],
    reconciliation: ["approve_and_reconcile"],
    cancellation_refund_entitlements: ["reject"],
    data_and_privacy_boundaries: "The cover email is a draft for human review and never precedes the finalized quote.",
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: ["acme-ops/src/workflows/rfq-quote.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/providers/{stripe,hubspot,google,slack}.ts"],
};
