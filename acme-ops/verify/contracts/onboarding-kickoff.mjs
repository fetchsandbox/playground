import { action, agent, all, blocked, check, command, eq, noAction, runs, start, startAgain } from "./lib.mjs";

const CHANNEL = "C0GENERAL01";
const APPROVER = "U_RVP_SALES";
const PRICE = "price_1Pro_Monthly_USD"; // seeded active $49/month price on the Stripe twin

// Each check uses its own buyer so checks can't see each other's customers.
const deal = (caseId, over = {}) => ({
  dealId: `D-${caseId}`,
  company: "Globex",
  contact: { email: `buyer-${caseId.replaceAll("_", "-")}@globex.test`, firstname: "Hank", lastname: "Scorpio" },
  plan: { priceId: PRICE, quantity: 20 },
  onboardingChannel: CHANNEL,
  approvers: [APPROVER],
  ...over,
});
const parked = [eq("phase", "AWAITING_APPROVAL")];
const autoApplied = ["hubspot.upsert_customer", "stripe.ensure_customer", "gmail.draft_welcome", "slack.post_handoff"];

function faulted(id, name, provider, scenario, assertions) {
  return check(id, name, [start(id, deal(id))], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });
}

export const checks = [
  check("baseline", "Closed-won provisions CRM and Stripe customer, drafts the welcome, hands off in Slack; subscription and kickoff invite wait for approval", [start("baseline", deal("baseline"))], all(runs([...parked, eq("outcome", "ok")]), ...autoApplied.map((id) => runs([action(id, "applied")])), runs([action("stripe.create_subscription", "pending_approval")]), runs([action("calendar.kickoff_invite", "pending_approval")]))),
  check("approve_and_reconcile", "Approval starts exactly one subscription; read-back confirms CRM stage, Stripe customer and subscription quantity", [start("approve_and_reconcile", deal("approve_and_reconcile")), command("decide", 1, { decision: "approve", userId: APPROVER }), command("reconcile", 1)], all(runs([eq("phase", "DONE")]), runs([action("stripe.create_subscription", "applied", 1, [eq("reconciled", "match")])]), runs([action("hubspot.upsert_customer", "applied", 1, [eq("reconciled", "match")])]), runs([action("stripe.ensure_customer", "applied", 1, [eq("reconciled", "match")])]))),
  check("approve_by_stranger_refused", "A non-approver cannot start billing", [start("approve_by_stranger_refused", deal("approve_by_stranger_refused")), command("decide", 1, { decision: "approve", userId: "U_SDR" }, 403)], all(runs(parked), runs([action("stripe.create_subscription", "pending_approval")]))),
  check("reject", "Rejecting withholds the subscription and the invite", [start("reject", deal("reject")), command("decide", 1, { decision: "reject", userId: APPROVER })], all(runs([eq("phase", "REJECTED")]), runs([action("stripe.create_subscription", "rejected")]), runs([action("calendar.kickoff_invite", "rejected")]))),
  check("refired_trigger_no_double_subscription", "A closed-won trigger fired again after the first run was approved does not propose a second subscription", [start("refired_trigger_no_double_subscription", deal("refired")), command("decide", 1, { decision: "approve", userId: APPROVER }), start("refired_trigger_no_double_subscription", deal("refired"))], all(runs([], 2), runs([action("stripe.create_subscription", "applied")]), runs([noAction("stripe.create_subscription"), eq("phase", "AWAITING_APPROVAL")]))),
  check("unknown_price_no_stripe_writes", "An unknown price fails the billing check and nothing is created in Stripe", [start("unknown_price_no_stripe_writes", deal("unknown_price", { plan: { priceId: "price_DoesNotExist", quantity: 3 } }))], all(runs([agent("billing-check", "failed")]), runs([noAction("stripe.ensure_customer")]), runs([noAction("stripe.create_subscription")]), runs([action("hubspot.upsert_customer", "applied")]))),
  check("invalid_input_rejected", "Zero seats is rejected before any agent runs", [start("invalid_input_rejected", deal("invalid", { plan: { priceId: PRICE, quantity: 0 } }), { expectStatus: 400 })], runs([], 0)),
  check("duplicate_start", "A re-delivered closed-won event does not provision twice", [start("duplicate_start", deal("duplicate_start")), startAgain("duplicate_start", deal("duplicate_start"))], all(runs([eq("duplicateStarts", 1)]), runs([action("stripe.ensure_customer", "applied", 1, [eq("attempts", 1)])]))),
  check("concurrent_start", "Four simultaneous closed-won deliveries create one run and one Stripe customer", [start("concurrent_start", deal("concurrent_start"), { runId: "{{run_id}}", concurrency: 4 })], all(runs([eq("duplicateStarts", 3)]), runs([action("stripe.ensure_customer", "applied", 1, [eq("attempts", 1)])]))),
  faulted("stripe_auth_failure", "Stripe auth failure: no Stripe writes are attempted; CRM and handoff continue", "stripe", "auth_failure", [agent("billing-check", "failed"), noAction("stripe.ensure_customer"), action("hubspot.upsert_customer", "applied")]),
  faulted("hubspot_auth_failure", "HubSpot auth failure: no CRM write; Stripe customer and handoff continue", "hubspot", "auth_failure", [agent("crm-check", "failed"), noAction("hubspot.upsert_customer"), action("stripe.ensure_customer", "applied")]),
  faulted("slack_not_in_channel", "Slack not_in_channel fails the handoff post only", "slack", "not_in_channel", [action("slack.post_handoff", "failed"), action("stripe.create_subscription", "pending_approval"), eq("outcome", "partial")]),
  faulted("calendar_rate_limited", "Calendar rate limiting: no kickoff invite is proposed; billing approval still offered", "google-calendar", "rate_limited", [agent("kickoff-scheduler", "failed"), noAction("calendar.kickoff_invite"), action("stripe.create_subscription", "pending_approval")]),
  blocked("zendesk_provisioning", "The buyer's Zendesk organization and requester are created", "setup_missing", "FetchSandbox has no Zendesk twin yet; zendesk.provision_requester is recorded as skipped/not_configured.", ["acme-ops/src/workflows/onboarding-kickoff.ts zendesk.provision_requester", "validate_integration providers:[zendesk] → 'Unknown providers: zendesk'"]),
];

export default {
  workflow: "onboarding-kickoff",
  providers: ["stripe", "hubspot", "gmail", "google-calendar", "slack"],
  context: {
    goal: "Prove the onboarding-kickoff AgentCore runtime: closed-won → parallel CRM/billing/support/scheduling checks → CRM customer, Stripe customer, welcome draft, Slack handoff; gated subscription start and kickoff invite; read-back reconciliation.",
    workflow: "POST /invocations {action:start} runs the checks and auto actions and parks billing + invite for approval; {action:decide} applies them; {action:reconcile} re-reads HubSpot and Stripe. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["approve_by_stranger_refused"],
    schema_and_value_boundaries: ["invalid_input_rejected", "unknown_price_no_stripe_writes"],
    amount_currency_quantity: ["approve_and_reconcile", "invalid_input_rejected"],
    duplicate_replay: ["duplicate_start", "refired_trigger_no_double_subscription"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: ["refired_trigger_no_double_subscription"],
    delayed_or_missing_events: "No inbound provider events.",
    provider_auth_and_scopes: ["stripe_auth_failure", "hubspot_auth_failure"],
    rate_limit_server_error_timeout: ["calendar_rate_limited"],
    accepted_effect_response_loss: "Covered by side-effect claims in local tests.",
    partial_effects_and_recovery: ["slack_not_in_channel"],
    restart_and_durability: "Covered by local tests (test/engine.test.ts); not exercised through the relay.",
    reconciliation: ["approve_and_reconcile"],
    cancellation_refund_entitlements: ["reject"],
    data_and_privacy_boundaries: "Welcome email is a draft for human review; nothing is sent to the customer without approval.",
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: ["acme-ops/src/workflows/onboarding-kickoff.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/providers/{stripe,hubspot,google,slack,zendesk}.ts"],
};
