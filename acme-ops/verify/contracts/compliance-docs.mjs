import { action, agent, all, blocked, check, eq, noAction, restart, runs, start, startAgain } from "./lib.mjs";

// The Box twin has no seeded files, so every request takes the "prepare it" path.
const CHANNEL = "C0GENERAL01";
const req = (caseId, over = {}) => ({
  requester: { email: "alice@acmecorp.com", name: "Alice Johnson" },
  product: "Pro Plan",
  docTypes: ["rohs", "coc"],
  qualityChannel: CHANNEL,
  ...over,
});
const toQuality = [action("slack.post_request", "applied"), action("asana.request_documents", "applied"), action("gmail.draft_holding_reply", "applied")];

function faulted(id, name, provider, scenario, assertions, input = req(id)) {
  return check(id, name, [start(id, input)], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });
}

export const checks = [
  check("baseline", "Documents not in the library are routed to Quality with a holding reply; nothing is shared", [start("baseline", req("baseline"))], all(runs([eq("phase", "DONE"), eq("outcome", "ok")]), ...toQuality.map((a) => runs([a])), runs([noAction("gmail.draft_documents")]))),
  check("unknown_part_no_reply", "A request for an unknown part gets no customer reply, only a Quality review note", [start("unknown_part_no_reply", req("unknown_part", { product: "Flux Capacitor" }))], all(runs([agent("part-check", "failed")]), runs([action("slack.post_request", "applied")]), runs([noAction("asana.request_documents")]), runs([noAction("gmail.draft_holding_reply")]))),
  check("duplicate_start", "A re-delivered request opens one Quality task", [start("duplicate_start", req("duplicate_start")), startAgain("duplicate_start", req("duplicate_start"))], all(runs([action("asana.request_documents", "applied", 1, [eq("attempts", 1)])]))),
  check("concurrent_start", "Four more simultaneous deliveries open one Quality task", [start("concurrent_start", req("concurrent_start")), startAgain("concurrent_start", req("concurrent_start"), 1, 4)], all(runs([action("asana.request_documents", "applied", 1, [eq("attempts", 1)])]))),
  check("invalid_input_rejected", "A request naming no documents is rejected before any agent runs", [start("invalid_input_rejected", req("invalid", { docTypes: [] }), { expectStatus: 400 })], runs([], 0)),
  faulted("box_auth_failure", "If the Box library can't be searched, the request still reaches Quality (flagged) instead of claiming documents are missing", "box", "auth_failure", [agent("document-library", "failed"), action("asana.request_documents", "applied"), action("gmail.draft_holding_reply", "applied")]),
  faulted("asana_rate_limited", "Asana rate limiting fails the Quality task only; the holding reply is still drafted", "asana", "rate_limited", [action("asana.request_documents", "failed"), action("gmail.draft_holding_reply", "applied"), eq("outcome", "partial")]),
  faulted("slack_rate_limited", "Slack rate limiting fails the channel post only", "slack", "rate_limited", [action("slack.post_request", "failed"), action("asana.request_documents", "applied")]),
  check("restart_then_redelivery", "After a runtime restart, a re-delivered request finds the saved run and repeats nothing", [start("restart_then_redelivery", req("restart")), restart, startAgain("restart_then_redelivery", req("restart"))], all(runs([eq("phase", "DONE")]), runs([action("asana.request_documents", "applied", 1, [eq("attempts", 1)])]), runs([action("gmail.draft_holding_reply", "applied", 1, [eq("attempts", 1)])]))),
  blocked("box_document_share_gated", "A released document found in Box is shared by an expiring link only after approval, then sent in a drafted reply", "setup_missing", "The Box twin has no seeded files and its search returns sample data, so the found-document path (gated box.share_document + gmail.draft_documents) is never reached; matchDoc() is covered by local reasoning only.", ["acme-ops/src/workflows/compliance-docs.ts box.share_document", "GET /search on the Box twin returns a sample object with no entries"]),
  blocked("zendesk_ticket_reply", "The reply is posted on the customer's Zendesk ticket", "setup_missing", "FetchSandbox has no Zendesk twin yet; replies are Gmail drafts.", ["validate_integration providers:[zendesk] → 'Unknown providers: zendesk'"]),
];

export default {
  workflow: "compliance-docs",
  providers: ["stripe", "hubspot", "gmail", "slack", "asana", "box"],
  context: {
    goal: "Prove the compliance-docs AgentCore runtime: document request → parallel part validation (Stripe), requester (HubSpot), Box library search → Quality task + holding reply, or gated external share.",
    workflow: "POST /invocations {action:start} validates the part, searches the library and routes missing documents to Quality; found documents are shared only after {action:decide}.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["box_document_share_gated"],
    schema_and_value_boundaries: ["invalid_input_rejected", "unknown_part_no_reply"],
    amount_currency_quantity: "No amounts are involved.",
    duplicate_replay: ["duplicate_start", "restart_then_redelivery"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: "One trigger per request.",
    delayed_or_missing_events: "No inbound provider events.",
    provider_auth_and_scopes: ["box_auth_failure"],
    rate_limit_server_error_timeout: ["asana_rate_limited", "slack_rate_limited"],
    accepted_effect_response_loss: "Covered by side-effect claims in local tests.",
    partial_effects_and_recovery: ["asana_rate_limited"],
    restart_and_durability: ["restart_then_redelivery"],
    reconciliation: ["zendesk_ticket_reply"],
    cancellation_refund_entitlements: "No cancellations or refunds.",
    data_and_privacy_boundaries: ["box_document_share_gated", "unknown_part_no_reply"],
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: ["acme-ops/src/workflows/compliance-docs.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/providers/{stripe,hubspot,google,slack,work}.ts"],
};
