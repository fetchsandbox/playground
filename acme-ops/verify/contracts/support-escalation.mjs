import { restart, action, agent, all, blocked, check, command, eq, noAction, runs, start, startAgain } from "./lib.mjs";

const CHANNEL = "C0INCIDENT"; // seeded #incidents channel on the Slack twin
const APPROVER = "U_SUPPORT_LEAD";

// Alice is a seeded Stripe customer with an active subscription.
const urgent = (id) => ({
  ticket: { id, subject: "Dashboard down for our whole team", description: "Everyone gets a 503 error since 9am.", requester: { email: "alice@acmecorp.com", name: "Alice Johnson" } },
  escalationChannel: CHANNEL,
  approvers: [APPROVER],
});

const parked = [eq("phase", "AWAITING_APPROVAL")];
const escalated = [action("slack.post_escalation", "applied"), action("calendar.hold_callback", "applied"), action("gmail.draft_reply", "applied"), action("zendesk.public_reply", "pending_approval")];

function faulted(id, name, provider, scenario, assertions) {
  return check(id, name, [start(id, urgent(7000 + id.length))], all(runs(parked), ...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });
}

const ZENDESK_GAP = [
  "acme-ops/src/providers/zendesk.ts (Zendesk REST v2 client, ZENDESK_BASE_URL)",
  "validate_integration providers:[zendesk] → 'Unknown providers: zendesk' (no FetchSandbox Zendesk twin yet)",
];

export const checks = [
  check("baseline", "Urgent ticket from a paying customer is escalated, a callback is held, a reply is drafted, and the public reply waits for approval", [start("baseline", urgent(4242))], all(runs([...parked, eq("outcome", "ok")]), ...escalated.map((a) => runs([a])), runs([agent("billing-health", "ok")]))),
  check("approve_by_approver", "The named approver's approval completes the run", [start("approve_by_approver", urgent(4243)), command("decide", 1, { decision: "approve", userId: APPROVER })], all(runs([eq("phase", "DONE")]), runs([action("slack.post_escalation", "applied")]))),
  check("approve_by_stranger_refused", "An approval from someone who is not an approver is refused and changes nothing", [start("approve_by_stranger_refused", urgent(4244)), command("decide", 1, { decision: "approve", userId: "U_STRANGER" }, 403)], all(runs(parked), runs([action("zendesk.public_reply", "pending_approval")]))),
  check("reject", "Rejecting withholds the public reply", [start("reject", urgent(4245)), command("decide", 1, { decision: "reject", userId: APPROVER })], all(runs([eq("phase", "REJECTED")]), runs([action("zendesk.public_reply", "rejected")]))),
  check("duplicate_start", "Re-sending the same trigger does not run the workflow twice", [start("duplicate_start", urgent(4246)), startAgain("duplicate_start", urgent(4246))], all(runs([action("slack.post_escalation", "applied", 1, [eq("attempts", 1)])]))),
  check("concurrent_start", "Four more simultaneous deliveries of one trigger create one run and one escalation", [start("concurrent_start", urgent(4247)), startAgain("concurrent_start", urgent(4247), 1, 4)], all(runs([action("slack.post_escalation", "applied", 1, [eq("attempts", 1)])]))),
  check("invalid_input_rejected", "A trigger without a requester email is rejected before any agent runs", [start("invalid_input_rejected", { ticket: { id: 1, subject: "x", requester: { email: "not-an-email" } }, escalationChannel: CHANNEL }, { expectStatus: 400 })], runs([], 0)),
  check("low_severity_not_escalated", "A how-to question from a non-customer is not escalated to Slack", [start("low_severity_not_escalated", { ticket: { id: 4248, subject: "How do I export to CSV?", description: "Where is the export button?", requester: { email: "curious@nowhere.test" } }, escalationChannel: CHANNEL })], all(runs(parked), runs([noAction("slack.post_escalation")]), runs([action("gmail.draft_reply", "applied")]))),
  faulted("slack_channel_not_found", "Slack channel_not_found fails only the escalation post; the run is partial and the draft still exists", "slack", "channel_not_found", [action("slack.post_escalation", "failed"), action("gmail.draft_reply", "applied"), eq("outcome", "partial")]),
  faulted("slack_rate_limited", "Slack rate limiting past retries is recorded as a failed post, not a lost run", "slack", "rate_limited", [action("slack.post_escalation", "failed"), action("calendar.hold_callback", "applied")]),
  faulted("stripe_auth_failure", "Stripe auth failure isolates the billing agent; triage and escalation continue", "stripe", "auth_failure", [agent("billing-health", "failed"), action("slack.post_escalation", "applied")]),
  faulted("hubspot_auth_failure", "HubSpot auth failure isolates the account agent; escalation continues", "hubspot", "auth_failure", [agent("account-context", "failed"), action("slack.post_escalation", "applied")]),
  faulted("calendar_auth_failure", "Calendar auth failure means no callback hold is attempted; escalation continues", "google-calendar", "auth_failure", [agent("callback-availability", "failed"), noAction("calendar.hold_callback"), action("slack.post_escalation", "applied")]),
  faulted("gmail_rate_limited", "Gmail rate limiting fails only the reply draft", "gmail", "rate_limited", [action("gmail.draft_reply", "failed"), action("slack.post_escalation", "applied")]),
  check("restart_while_parked", "A run parked for approval survives a real runtime restart and completes when approved afterwards", [start("restart_while_parked", urgent(4249)), restart, command("decide", 1, { decision: "approve", userId: APPROVER })], runs([eq("phase", "DONE")])),
  blocked("zendesk_ticket_annotation", "Ticket is annotated (priority, tags, internal note) and the approved reply is posted publicly in Zendesk", "setup_missing", "FetchSandbox has no Zendesk twin yet; the runtime records zendesk.* actions as skipped/not_configured.", ZENDESK_GAP),
];

export default {
  workflow: "support-escalation",
  providers: ["stripe", "hubspot", "gmail", "google-calendar", "slack"],
  context: {
    goal: "Prove the support-escalation AgentCore runtime: Zendesk ticket → parallel agents (triage, HubSpot account, Stripe billing, Calendar availability) → escalation, callback hold, reply draft, gated public reply.",
    workflow: "POST /invocations {action:start} runs the agents and auto actions and parks the run for approval; {action:decide} applies or withholds gated actions. GET /verify/runs/{run}/cases/{case}/runs reads the saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records (phase, agents[], actions[] with status/attempts/errorCode, duplicateStarts) in the runtime's store, exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected by the verifier token.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["approve_by_stranger_refused", "approve_by_approver"],
    schema_and_value_boundaries: ["invalid_input_rejected", "low_severity_not_escalated"],
    amount_currency_quantity: "The workflow reads balances for the brief but never moves money or changes amounts.",
    duplicate_replay: ["duplicate_start"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: "Single trigger per run; ticket state is re-read from Zendesk when connected rather than trusted from the payload.",
    delayed_or_missing_events: "No inbound provider webhooks; the control plane delivers the trigger synchronously.",
    provider_auth_and_scopes: ["stripe_auth_failure", "hubspot_auth_failure", "calendar_auth_failure"],
    rate_limit_server_error_timeout: ["slack_rate_limited", "gmail_rate_limited"],
    accepted_effect_response_loss: "Covered by side-effect claims in local tests; no provider here supports a verifiable lost-response replay on the twins.",
    partial_effects_and_recovery: ["slack_channel_not_found", "restart_while_parked"],
    restart_and_durability: ["restart_while_parked"],
    reconciliation: ["zendesk_ticket_annotation"],
    cancellation_refund_entitlements: ["reject"],
    data_and_privacy_boundaries: "Customer text is wrapped as untrusted data for drafting and stripped of Slack markup; no PII leaves the listed providers.",
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: [
    "acme-ops/src/workflows/support-escalation.ts",
    "acme-ops/src/kit/engine.ts",
    "acme-ops/src/kit/server.ts POST /invocations, GET /verify/runs/:run/cases/:case/runs",
    "acme-ops/src/providers/{stripe,hubspot,google,slack,zendesk}.ts",
  ],
};
