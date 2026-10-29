import { action, agent, all, blocked, check, eq, noAction, restart, runs, start, startAgain } from "./lib.mjs";

// Executable expectations for signed-agreement-filing (DocuSign → Box or
// Dropbox, Slack). FetchSandbox has no DocuSign or Dropbox twin
// (validate_integration: "Unknown providers: docusign, dropbox"), so the runtime
// runs with DocuSign unconfigured: what can be measured is that it fails closed
// (nothing filed, Legal told), dedupes, survives restart and rejects bad input.
// The filing rules themselves are blocked checks with the exact reason, and are
// covered locally by test/signed-agreement-filing.test.ts against a vendor-doc fake.
const ENVELOPE = "3f1c2b7a-5d4e-4c3b-9a8f-7e6d5c4b3a21";
const input = (over = {}) => ({ envelopeId: ENVELOPE, ...over });
const failClosed = [eq("output.mode", "blocked"), agent("envelope", "skipped")];
const NO_DOCUSIGN = ["validate_integration providers:[docusign, dropbox] → 'Validation sessions require distinct known providers. Unknown providers: docusign, dropbox' (2026-10-29)", "list_specs filter docusign → 0 specs"];

export const checks = [
  check("baseline", "A Connect event starts one recorded run (provider-independent, so every later check is measured)", [start("baseline", input())], runs([], 1)),
  check("docusign_unavailable_files_nothing", "When the envelope can't be read, nothing is filed and Legal is told the PDF is still only in DocuSign", [start("docusign_unavailable_files_nothing", input())], all(runs(failClosed), runs([action("slack.post_unreadable", "applied")]), runs([noAction("storage.file_signed")]))),
  check("duplicate_delivery", "A re-delivered Connect event finds the same run and posts once", [start("duplicate_delivery", input()), startAgain("duplicate_delivery", input())], all(runs([action("slack.post_unreadable", "applied", 1, [eq("attempts", 1)])]))),
  check("concurrent_delivery", "Four simultaneous deliveries of the same event post once", [start("concurrent_delivery", input()), startAgain("concurrent_delivery", input(), 1, 4)], all(runs([action("slack.post_unreadable", "applied", 1, [eq("attempts", 1)])]))),
  check("invalid_input_rejected", "An envelope id that isn't a DocuSign GUID is rejected before any agent runs", [start("invalid_input_rejected", input({ envelopeId: "../../etc/passwd" }), { expectStatus: 400 })], runs([], 0)),
  check("slack_rate_limited", "Slack rate limiting fails the Legal notice visibly; it is never reported as delivered", [start("slack_rate_limited", input())], all(runs([action("slack.post_unreadable", "failed")])), { fault: { provider: "slack", scenario: "rate_limited", evidence: "refusal" } }),
  check("restart_then_redelivery", "After a runtime restart, a re-delivered event finds the saved run and repeats nothing", [start("restart_then_redelivery", input()), restart, startAgain("restart_then_redelivery", input())], all(runs([eq("phase", "DONE")]), runs([action("slack.post_unreadable", "applied", 1, [eq("attempts", 1)])]))),
  blocked("filed_in_type_folder", "A completed, countersigned MSA is filed with its certificate in the MSA folder of the policy's store and its channel is told", "setup_missing", "No DocuSign twin: the completed envelope, its form data and documents/combined can't be served, so nothing reaches the store.", NO_DOCUSIGN),
  blocked("refiling_is_idempotent", "A second Connect delivery of a filed envelope (new run id) files nothing new", "setup_missing", "Needs the DocuSign twin (completed envelope) and a store that keeps uploaded files by name in their folder.", NO_DOCUSIGN),
  blocked("type_from_subject", "With no type field, the subject rules classify the envelope (NDA → NDAs folder, nobody notified)", "setup_missing", "Needs the DocuSign twin to return an envelope subject and empty custom fields.", NO_DOCUSIGN),
  blocked("unknown_type_to_review", "A type the policy doesn't know is filed to the review folder and Legal is told why; nothing is guessed", "setup_missing", "Needs the DocuSign twin to return a custom field the policy doesn't list.", NO_DOCUSIGN),
  blocked("missing_countersignature_to_review", "A type that needs an internal countersignature, signed only externally, is filed for review", "setup_missing", "Needs the DocuSign twin to return recipients with per-signer status.", NO_DOCUSIGN),
  blocked("not_completed_ignored", "A sent or delivered (not completed) envelope files nothing", "setup_missing", "Needs the DocuSign twin to return a non-completed envelope.", NO_DOCUSIGN),
  blocked("dropbox_store", "With the policy's store set to Dropbox, the PDF is uploaded through content.dropboxapi.com without overwriting", "setup_missing", "No Dropbox twin.", ["validate_integration providers:[dropbox] → 'Unknown providers: dropbox' (2026-10-29)"]),
  blocked("box_store_follows_box_api", "Filing into Box walks and creates the folder path (409 on an existing name) and uploads under the given name", "setup_missing", "The Box twin diverges from Box's API on every call the store makes, so even with DocuSign available the filing couldn't be judged.", [
    "GET /folders/0/items → {items:[{…entries:[sample objects]}]} instead of {entries,total_count,…}; folders created in the session don't appear",
    "POST /folders twice with the same name → 201 both times (Box: 409 item_name_in_use); id is a UUID, not a numeric string",
    "POST /files/content → entries[0].id 'obj_…', name 'item-…' (not the uploaded name), parent null",
    "PUT /files/{uploaded id}?fields=shared_link and GET /files/{uploaded id} → 404",
  ]),
  blocked("store_refusal_reported", "If the store refuses the upload, Legal is told the PDF is still only in DocuSign", "setup_missing", "Reaching the upload needs a completed DocuSign envelope; box:rate_limited/auth_failure can't be reached first.", NO_DOCUSIGN),
];

export default {
  workflow: "signed-agreement-filing",
  providers: ["slack"],
  context: {
    goal: "Prove the signed-agreement-filing AgentCore runtime: a DocuSign Connect envelope-completed event → read envelope (recipients, custom fields, form data) → classify by policy → file the combined PDF with certificate in Box or Dropbox (policy) → tell the type's channel; review folder for unknown types and missing countersignatures; fail closed when DocuSign can't be read.",
    workflow: "POST /invocations {action:start, input:{envelopeId}}; policy from policies/signed-agreement-filing.json. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["missing_countersignature_to_review"],
    schema_and_value_boundaries: ["invalid_input_rejected", "unknown_type_to_review"],
    amount_currency_quantity: "No amounts are involved.",
    duplicate_replay: ["duplicate_delivery", "refiling_is_idempotent", "restart_then_redelivery"],
    concurrency: ["concurrent_delivery"],
    ordering_and_stale_events: ["not_completed_ignored"],
    delayed_or_missing_events: "A missed Connect event is recovered by the daily sweep of completed envelopes calling start; the same run id dedupes it.",
    provider_auth_and_scopes: ["docusign_unavailable_files_nothing"],
    rate_limit_server_error_timeout: ["slack_rate_limited", "store_refusal_reported"],
    accepted_effect_response_loss: "Filing checks the store by name before uploading, so a lost upload response is re-found on resume; covered locally.",
    partial_effects_and_recovery: ["store_refusal_reported"],
    restart_and_durability: ["restart_then_redelivery"],
    reconciliation: ["filed_in_type_folder"],
    cancellation_refund_entitlements: "No cancellations or refunds.",
    data_and_privacy_boundaries: ["docusign_unavailable_files_nothing", "unknown_type_to_review"],
    cleanup_and_isolation: ["baseline", "concurrent_delivery"],
  },
  evidence: ["acme-ops/src/workflows/signed-agreement-filing.ts", "acme-ops/policies/signed-agreement-filing.json", "acme-ops/src/providers/storage.ts", "acme-ops/src/providers/work.ts DocuSignClient", "acme-ops/src/kit/engine.ts"],
};
