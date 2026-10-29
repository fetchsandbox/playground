import { action, agent, all, blocked, check, eq, noAction, restart, runs, start, startAgain } from "./lib.mjs";

// Executable expectations for vendor-compliance-docs (DocuSign onboarding
// packet → Box or Dropbox; certificate of insurance tracked from the vendor's
// Box/Dropbox Insurance folder; Slack, Gmail drafts). There is no DocuSign or
// Dropbox twin, so onboarding runs fail closed. The Box twin is used for the
// insurance folder: the runtime reads it exactly as Box documents it, so a twin
// that answers differently shows up here as a violated check, not a pass.
const vendor = (c, over = {}) => ({ vendorId: `V-${c.replaceAll("_", "-")}`.slice(0, 40), vendor: { legalName: `Initech ${c}`.slice(0, 60), contactName: "Bill Lumbergh", contactEmail: "bill@initech.example" }, riskTier: "high", processesPersonalData: true, ...over });
const NO_DOCUSIGN = ["validate_integration providers:[docusign, dropbox] → 'Validation sessions require distinct known providers. Unknown providers: docusign, dropbox' (2026-10-29)"];
const BOX_TD = [
  "GET /folders/0/items → {items:[{…entries:[sample objects]}]} instead of {entries,total_count,…}",
  "POST /files/content keeps neither the uploaded name nor the parent folder, so a 'COI <date>.pdf' certificate can't be seeded",
];

export const checks = [
  check("baseline", "An onboarding request starts one recorded run (provider-independent, so every later check is measured)", [start("baseline", vendor("baseline"))], runs([], 1)),
  check("docusign_unavailable_sends_nothing", "When DocuSign can't be checked, no onboarding documents are sent and Procurement is told", [start("docusign_unavailable_sends_nothing", vendor("ds_down"))], all(runs([eq("output.onboarding", "blocked"), agent("envelopes", "skipped")]), runs([action("slack.post_blocked", "applied")]), runs([noAction("docusign.send_onboarding")]))),
  check("insurance_folder_read_from_box", "The vendor's Insurance folder is read from Box (folder walk from the root, marker paging)", [start("insurance_folder_read_from_box", vendor("box_read", { insuranceOnly: true }))], runs([agent("insurance", "ok")])),
  check("missing_certificate_raised", "A high-risk vendor with no certificate in its Insurance folder is raised to Procurement at once", [start("missing_certificate_raised", vendor("coi_missing", { insuranceOnly: true }))], all(runs([eq("output.insurance", "missing")]), runs([action("procurement.coi_missing", "applied")]))),
  check("unreadable_folder_is_not_missing", "If Box refuses the folder read, Procurement is told expiry isn't tracked; it is never reported as 'no certificate'", [start("unreadable_folder_is_not_missing", vendor("box_down", { insuranceOnly: true }))], all(runs([eq("output.insurance", "unreadable"), agent("insurance", "failed")]), runs([action("slack.post_insurance_unreadable", "applied")]), runs([noAction("procurement.coi_missing")])), { fault: { provider: "box", scenario: "auth_failure", evidence: "refusal" } }),
  check("duplicate_request", "A re-delivered onboarding request finds the same run and posts once", [start("duplicate_request", vendor("duplicate")), startAgain("duplicate_request", vendor("duplicate"))], runs([action("slack.post_blocked", "applied", 1, [eq("attempts", 1)])])),
  check("concurrent_requests", "Four simultaneous deliveries post once", [start("concurrent_requests", vendor("concurrent")), startAgain("concurrent_requests", vendor("concurrent"), 1, 4)], runs([action("slack.post_blocked", "applied", 1, [eq("attempts", 1)])])),
  check("invalid_input_rejected", "An unknown risk tier or invalid contact email is rejected before any agent runs", [start("invalid_input_rejected", vendor("invalid", { riskTier: "critical", vendor: { legalName: "X", contactName: "Y", contactEmail: "nope" } }), { expectStatus: 400 })], runs([], 0)),
  check("slack_rate_limited", "Slack rate limiting fails the Procurement notice visibly", [start("slack_rate_limited", vendor("slack_rl"))], runs([action("slack.post_blocked", "failed")]), { fault: { provider: "slack", scenario: "rate_limited", evidence: "refusal" } }),
  check("restart_then_redelivery", "After a runtime restart, a re-delivered request finds the saved run and repeats nothing", [start("restart_then_redelivery", vendor("restart")), restart, startAgain("restart_then_redelivery", vendor("restart"))], all(runs([eq("phase", "DONE")]), runs([action("slack.post_blocked", "applied", 1, [eq("attempts", 1)])]))),
  blocked("packet_by_tier_with_dpa", "A high-risk vendor processing personal data gets W-9, MSA, security addendum and DPA in one envelope, countersigned by Procurement", "setup_missing", "No DocuSign twin.", NO_DOCUSIGN),
  blocked("onboarding_filed_on_completion", "Connect completion is re-checked with DocuSign and the signed packet is filed in the vendor's Onboarding folder", "setup_missing", "No DocuSign twin; Box twin uploads lose name and parent.", [...NO_DOCUSIGN, ...BOX_TD]),
  blocked("envelope_reused", "Re-onboarding the same vendor reuses its envelope", "setup_missing", "Needs DocuSign envelope listing by custom_field.", NO_DOCUSIGN),
  blocked("unsigned_and_declined_escalated", "Unsigned after 7 and 14 days, and declined, are each escalated", "setup_missing", "Needs the DocuSign twin and the runtime clock to advance during an attempt.", [...NO_DOCUSIGN, "/__fetchsandbox/fixtures/time is unavailable during active attempts"]),
  blocked("certificate_notices_and_renewal_draft", "60/30/7-day notices, a renewal request drafted to the vendor at 30 days, and a hold notice on expiry", "setup_missing", "A dated certificate can't be seeded into a Box folder (name and parent dropped), and the timers need the runtime clock during an attempt.", [...BOX_TD, "/__fetchsandbox/fixtures/time is unavailable during active attempts"]),
  blocked("renewed_certificate_stands_down", "A newer certificate filed in the folder stands every remaining insurance timer down", "setup_missing", "Needs a stateful Box folder (R29) and the clock.", BOX_TD),
  blocked("dropbox_store", "With the store set to Dropbox, the Insurance folder is listed and the packet uploaded there", "setup_missing", "No Dropbox twin.", ["validate_integration providers:[dropbox] → 'Unknown providers: dropbox' (2026-10-29)"]),
];

export default {
  workflow: "vendor-compliance-docs",
  providers: ["slack", "box", "gmail"],
  context: {
    goal: "Prove the vendor-compliance-docs AgentCore runtime: supplier onboarding → DocuSign packet by risk tier (+DPA) → filed in Box/Dropbox on completion; certificate of insurance tracked from the vendor's Insurance folder (file names 'COI <expiry>.pdf'): raised at once when required and missing or expired, notices at 60/30/7 days, renewal request draft at 30, hold notice on expiry, standing down when a newer certificate is filed; an unreadable folder is never treated as missing.",
    workflow: "POST /invocations {action:start, input:{vendorId, vendor, riskTier, processesPersonalData, insuranceOnly}}; signal from the Connect adapter; tick for timers. Policy: policies/vendor-compliance-docs.json.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["onboarding_filed_on_completion"],
    schema_and_value_boundaries: ["invalid_input_rejected", "missing_certificate_raised"],
    amount_currency_quantity: "No amounts are involved.",
    duplicate_replay: ["duplicate_request", "envelope_reused", "restart_then_redelivery"],
    concurrency: ["concurrent_requests"],
    ordering_and_stale_events: ["renewed_certificate_stands_down"],
    delayed_or_missing_events: ["unsigned_and_declined_escalated", "certificate_notices_and_renewal_draft"],
    provider_auth_and_scopes: ["docusign_unavailable_sends_nothing", "unreadable_folder_is_not_missing"],
    rate_limit_server_error_timeout: ["slack_rate_limited"],
    accepted_effect_response_loss: "Sending re-checks DocuSign by external id first and filing checks the store by name, so lost responses are found on resume; covered locally.",
    partial_effects_and_recovery: ["unreadable_folder_is_not_missing"],
    restart_and_durability: ["restart_then_redelivery"],
    reconciliation: ["insurance_folder_read_from_box", "renewed_certificate_stands_down"],
    cancellation_refund_entitlements: ["unsigned_and_declined_escalated"],
    data_and_privacy_boundaries: ["packet_by_tier_with_dpa"],
    cleanup_and_isolation: ["baseline", "concurrent_requests"],
  },
  evidence: ["acme-ops/src/workflows/vendor-compliance-docs.ts", "acme-ops/policies/vendor-compliance-docs.json", "acme-ops/src/providers/storage.ts", "acme-ops/src/providers/work.ts", "acme-ops/src/kit/engine.ts"],
};
