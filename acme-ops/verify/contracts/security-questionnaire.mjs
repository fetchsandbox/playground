import { action, agent, all, blocked, check, command, eq, restart, runs, start, startAgain } from "./lib.mjs";

const CHANNEL = "G0PRIVATE01";
const APPROVER = "U_CISO";
const review = (who, over = {}) => ({
  customer: { name: "Globex Corporation", email: `${who.replaceAll("_", "-")}@globex.test` },
  questions: [
    { id: "Q1", text: "Do you encrypt customer data at rest and in transit?" },
    { id: "Q2", text: "Do you have a current SOC 2 Type II report?" },
    { id: "Q3", text: "How do you manage privileged access to production systems?" },
  ],
  libraryDatabaseId: "db_security_answers",
  securityChannel: CHANNEL,
  approvers: [APPROVER],
  ...over,
});
const parked = [eq("phase", "AWAITING_APPROVAL")];

function faulted(id, name, provider, scenario, assertions) {
  return check(id, name, [start(id, review(id))], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });
}

export const checks = [
  check("baseline", "A questionnaire is matched against the library; unanswered questions go to Security and the response draft waits for approval", [start("baseline", review("baseline"))], all(runs([...parked, eq("outcome", "ok")]), runs([action("asana.security_review", "applied")]), runs([action("slack.post_summary", "applied")]), runs([action("gmail.draft_response", "pending_approval")]))),
  check("approve_and_reconcile", "Approval creates the customer draft; the Security task is read back", [start("approve_and_reconcile", review("approved")), command("decide", 1, { decision: "approve", userId: APPROVER }), command("reconcile", 1)], all(runs([eq("phase", "DONE")]), runs([action("gmail.draft_response", "applied")]), runs([action("asana.security_review", "applied", 1, [eq("reconciled", "match")])]))),
  check("approve_by_stranger_refused", "A non-approver cannot release answers to a customer", [start("approve_by_stranger_refused", review("stranger")), command("decide", 1, { decision: "approve", userId: "U_SALES_REP" }, 403)], all(runs(parked), runs([action("gmail.draft_response", "pending_approval")]))),
  check("reject", "Rejecting withholds the customer draft", [start("reject", review("rejected")), command("decide", 1, { decision: "reject", userId: APPROVER })], all(runs([eq("phase", "REJECTED")]), runs([action("gmail.draft_response", "rejected")]))),
  check("duplicate_start", "A re-delivered questionnaire does not open a second Security task", [start("duplicate_start", review("duplicate")), startAgain("duplicate_start", review("duplicate"))], runs([action("asana.security_review", "applied", 1, [eq("attempts", 1)])])),
  check("concurrent_start", "Four more simultaneous deliveries create one run", [start("concurrent_start", review("concurrent")), startAgain("concurrent_start", review("concurrent"), 1, 4)], runs([action("asana.security_review", "applied", 1, [eq("attempts", 1)])])),
  check("invalid_input_rejected", "Duplicate question ids are rejected before anything runs", [start("invalid_input_rejected", review("invalid", { questions: [{ id: "Q1", text: "Encryption at rest?" }, { id: "Q1", text: "Encryption in transit?" }] }), { expectStatus: 400 })], runs([], 0)),
  faulted("notion_auth_failure", "If the answer library can't be read, every question goes to Security and nothing is answered from memory", "notion", "auth_failure", [agent("answer-library", "failed"), action("asana.security_review", "applied"), action("gmail.draft_response", "pending_approval")]),
  faulted("asana_rate_limited", "An Asana outage fails the Security task only; the summary still posts", "asana", "rate_limited", [action("asana.security_review", "failed"), action("slack.post_summary", "applied"), eq("outcome", "partial")]),
  faulted("slack_auth_failure", "A Slack failure loses the summary only", "slack", "auth_failure", [action("slack.post_summary", "failed"), action("asana.security_review", "applied")]),
  check("restart_while_parked", "A response parked for approval survives a runtime restart and is drafted when approved afterwards", [start("restart_while_parked", review("restart")), restart, command("decide", 1, { decision: "approve", userId: APPROVER })], runs([eq("phase", "DONE"), action("gmail.draft_response", "applied")])),
  blocked("answers_from_library", "Questions that match an approved Notion answer are answered with that exact text", "setup_missing", "The Notion twin's database query returns generic sample pages without Question/Answer properties, so no question can match the library; the matcher itself is deterministic code (similarity ≥ 0.5).", ["acme-ops/src/workflows/security-questionnaire.ts matchQuestions, libraryFromPages", "Notion twin POST /v1/databases/{id}/query returns sample pages"]),
];

export default {
  workflow: "security-questionnaire",
  providers: ["notion", "hubspot", "asana", "slack", "gmail"],
  context: {
    goal: "Prove the security-questionnaire AgentCore runtime: Notion answer library ‖ HubSpot customer → deterministic answer matching, Security task in Asana, Slack summary, gated customer draft in Gmail.",
    workflow: "POST /invocations {action:start} matches questions and parks the customer draft; {action:decide} creates or withholds it; {action:reconcile} re-reads Asana. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["approve_by_stranger_refused"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: "No amounts are involved.",
    duplicate_replay: ["duplicate_start"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: "A questionnaire is a single point-in-time request.",
    delayed_or_missing_events: "No inbound provider events.",
    provider_auth_and_scopes: ["notion_auth_failure", "slack_auth_failure"],
    rate_limit_server_error_timeout: ["asana_rate_limited"],
    accepted_effect_response_loss: "Covered by side-effect claims.",
    partial_effects_and_recovery: ["asana_rate_limited"],
    restart_and_durability: ["restart_while_parked"],
    reconciliation: ["approve_and_reconcile", "answers_from_library"],
    cancellation_refund_entitlements: ["reject"],
    data_and_privacy_boundaries: ["notion_auth_failure", "answers_from_library"],
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: ["acme-ops/src/workflows/security-questionnaire.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/providers/work.ts NotionClient, AsanaClient"],
};
