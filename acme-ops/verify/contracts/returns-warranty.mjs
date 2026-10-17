import { action, agent, all, blocked, check, command, eq, noAction, restart, runs, start, startAgain } from "./lib.mjs";

// Twin seed: alice@acmecorp.com owns paid invoice in_3QaT2bVwXy5zA6Bc7D (2025-01-01,
// in warranty until 2027-01-01); dev@startupxyz.io owns open invoice in_7EfG8hIjKl9mN0Op1Q.
const CHANNEL = "C0BILLING01";
const APPROVER = "U_CX_LEAD";
const PAID = "in_3QaT2bVwXy5zA6Bc7D";
const UNPAID = "in_7EfG8hIjKl9mN0Op1Q";

const claim = (caseId, over = {}) => ({
  customer: { email: "alice@acmecorp.com", name: "Alice Johnson" },
  invoiceId: PAID,
  partNumber: "GEMS-LS-200 level switch",
  serial: `SN-${caseId}`,
  failure: "Switch output stuck high after two weeks in service.",
  returnsChannel: CHANNEL,
  approvers: [APPROVER],
  ...over,
});
const parked = [eq("phase", "AWAITING_APPROVAL")];
const opened = [action("asana.create_rma", "applied"), action("gmail.draft_rma_instructions", "applied"), action("slack.post_rma", "applied")];

function faulted(id, name, provider, scenario, assertions, input = claim(id)) {
  return check(id, name, [start(id, input)], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });
}

export const checks = [
  check("baseline", "An in-warranty failure on a paid invoice opens the RMA, drafts return instructions, posts to Slack and parks the warranty credit for approval", [start("baseline", claim("baseline"))], all(runs([...parked, eq("outcome", "ok")]), ...opened.map((a) => runs([a])), runs([action("stripe.warranty_credit_note", "pending_approval")]))),
  check("approve_by_approver", "The CX lead's approval issues exactly one warranty credit note", [start("approve_by_approver", claim("approve_by_approver")), command("decide", 1, { decision: "approve", userId: APPROVER })], all(runs([eq("phase", "DONE")]), runs([action("stripe.warranty_credit_note", "applied", 1, [eq("attempts", 1)])]))),
  check("approve_by_stranger_refused", "A non-approver cannot issue a credit", [start("approve_by_stranger_refused", claim("approve_by_stranger_refused")), command("decide", 1, { decision: "approve", userId: "U_AGENT" }, 403)], all(runs(parked), runs([action("stripe.warranty_credit_note", "pending_approval")]))),
  check("reject", "Rejecting withholds the credit; the RMA still stands", [start("reject", claim("reject")), command("decide", 1, { decision: "reject", userId: APPROVER })], all(runs([eq("phase", "REJECTED")]), runs([action("stripe.warranty_credit_note", "rejected")]), runs([action("asana.create_rma", "applied")]))),
  check("unpaid_invoice_no_credit", "A return against an unpaid invoice gets an RMA but no credit (AR handles it)", [start("unpaid_invoice_no_credit", claim("unpaid", { customer: { email: "dev@startupxyz.io" }, invoiceId: UNPAID }))], all(runs([eq("phase", "DONE")]), runs([noAction("stripe.warranty_credit_note")]), runs([action("asana.create_rma", "applied")]))),
  check("no_credit_requested", "Repair-only returns propose no credit", [start("no_credit_requested", claim("no_credit_requested", { creditRequested: false }))], all(runs([eq("phase", "DONE")]), runs([noAction("stripe.warranty_credit_note")]), runs([action("asana.create_rma", "applied")]))),
  check("someone_elses_invoice_refused", "A claim against another customer's invoice issues no RMA, only a Slack note for manual verification", [start("someone_elses_invoice_refused", claim("not_owner", { invoiceId: UNPAID }))], all(runs([agent("order-lookup", "failed")]), runs([noAction("asana.create_rma")]), runs([noAction("stripe.warranty_credit_note")]), runs([action("slack.post_rma", "applied")]))),
  check("duplicate_start", "A re-delivered return request opens one RMA", [start("duplicate_start", claim("duplicate_start")), startAgain("duplicate_start", claim("duplicate_start"))], all(runs([action("asana.create_rma", "applied", 1, [eq("attempts", 1)])]))),
  check("concurrent_start", "Four more simultaneous deliveries of one request open one RMA", [start("concurrent_start", claim("concurrent_start")), startAgain("concurrent_start", claim("concurrent_start"), 1, 4)], all(runs([action("asana.create_rma", "applied", 1, [eq("attempts", 1)])]))),
  check("invalid_input_rejected", "A request without a Stripe invoice id is rejected before any agent runs", [start("invalid_input_rejected", claim("invalid", { invoiceId: "INV-2025-00001" }), { expectStatus: 400 })], runs([], 0)),
  faulted("stripe_auth_failure", "Without Stripe the purchase can't be verified: no RMA and no credit", "stripe", "auth_failure", [agent("order-lookup", "failed"), noAction("asana.create_rma"), noAction("stripe.warranty_credit_note"), action("slack.post_rma", "applied")]),
  faulted("asana_rate_limited", "Asana rate limiting fails the RMA task only; the draft, Slack post and credit approval continue", "asana", "rate_limited", [action("asana.create_rma", "failed"), action("gmail.draft_rma_instructions", "applied"), action("stripe.warranty_credit_note", "pending_approval"), eq("outcome", "partial")]),
  faulted("slack_rate_limited", "Slack rate limiting fails the post only", "slack", "rate_limited", [action("slack.post_rma", "failed"), action("asana.create_rma", "applied")]),
  check("restart_while_parked", "A credit parked for approval survives a real runtime restart and is issued when approved afterwards", [start("restart_while_parked", claim("restart")), restart, command("decide", 1, { decision: "approve", userId: APPROVER })], all(runs([eq("phase", "DONE")]), runs([action("stripe.warranty_credit_note", "applied", 1, [eq("attempts", 1)])]))),
  blocked("carrier_return_label", "A prepaid carrier return label is created with the RMA", "setup_missing", "No carrier twin (UPS/FedEx/EasyPost/Shippo) in FetchSandbox; the RMA asks the customer to ship to the returns address instead.", ["acme-ops/src/workflows/returns-warranty.ts gmail.draft_rma_instructions", "validate_integration providers:[easypost|shippo] → 'Unknown providers'"]),
  blocked("zendesk_ticket_link", "The customer's Zendesk ticket history is read and the RMA is linked to the ticket", "setup_missing", "FetchSandbox has no Zendesk twin yet; the ticket-history agent is skipped/not_configured.", ["acme-ops/src/workflows/returns-warranty.ts ticket-history", "validate_integration providers:[zendesk] → 'Unknown providers: zendesk'"]),
  blocked("credit_note_amount_readback", "Reconciliation confirms the issued credit note's amount in Stripe", "observation_missing", "The Stripe twin's credit_notes create/get return sample amounts, not the amount sent, so the read-back reports drift on the twin.", ["acme-ops/src/workflows/returns-warranty.ts stripe.warranty_credit_note reconcile", "GET /v1/credit_notes/{id} on the twin returns amount unrelated to the POSTed credit_amount"]),
];

export default {
  workflow: "returns-warranty",
  providers: ["stripe", "hubspot", "gmail", "slack", "asana"],
  context: {
    goal: "Prove the returns-warranty AgentCore runtime: failed-unit report → parallel Stripe purchase/warranty check, HubSpot account, Zendesk history → RMA task, return-instruction draft, Slack post; warranty credit note gated.",
    workflow: "POST /invocations {action:start} verifies the purchase and warranty, applies auto actions and parks the credit note for approval; {action:decide} issues or withholds it. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["approve_by_stranger_refused", "someone_elses_invoice_refused"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: ["credit_note_amount_readback", "unpaid_invoice_no_credit"],
    duplicate_replay: ["duplicate_start"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: "One trigger per return; warranty is computed from the invoice date at run start.",
    delayed_or_missing_events: "No inbound provider events.",
    provider_auth_and_scopes: ["stripe_auth_failure"],
    rate_limit_server_error_timeout: ["asana_rate_limited", "slack_rate_limited"],
    accepted_effect_response_loss: "Covered by side-effect claims in local tests.",
    partial_effects_and_recovery: ["asana_rate_limited"],
    restart_and_durability: ["restart_while_parked"],
    reconciliation: ["credit_note_amount_readback"],
    cancellation_refund_entitlements: ["approve_by_approver", "reject", "no_credit_requested"],
    data_and_privacy_boundaries: "Return instructions are a draft for human review; credits only on the claimant's own paid invoice.",
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: ["acme-ops/src/workflows/returns-warranty.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/providers/{stripe,hubspot,google,slack,work}.ts"],
};
