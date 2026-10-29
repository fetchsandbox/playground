import { action, actionKind, agent, all, blocked, check, eq, restart, runs, start, startAgain } from "./lib.mjs";

// Executable expectations for external-sharing-audit (Box + Dropbox shared
// links, Slack). Box has a twin and is read exactly as Box documents it
// (folder items with fields=shared_link, marker paging), so a twin that answers
// differently is a violated check here. Dropbox has no twin, so every run must
// say Dropbox was not audited, never that it was clean.
const audit = (c, over = {}) => ({ auditId: `SHARE-${c.replaceAll("_", "-")}`.slice(0, 46), approvers: ["U_SECLEAD"], ...over });
const NO_CHANGES = ["sharing.restrict", "sharing.set_expiry", "sharing.revoke"].map((k) => actionKind(k, null, 0));
const BOX_TD = [
  "GET /folders/0/items?fields=name,type,shared_link → {items:[{…entries:[sample objects]}]} instead of {entries,total_count,…}",
  "PUT /files/{id}?fields=shared_link on a file uploaded in the session → 404, so a public link can't be staged",
];
const NO_DROPBOX = ["validate_integration providers:[dropbox] → 'Unknown providers: dropbox' (2026-10-29)"];

export const checks = [
  check("baseline", "A scheduled audit starts one recorded run (provider-independent, so every later check is measured)", [start("baseline", audit("baseline"))], runs([], 1)),
  check("box_links_inventoried", "Every shared link in the Box tree is inventoried (folder walk with fields=shared_link, marker paging)", [start("box_links_inventoried", audit("box_inventory"))], runs([agent("box-links", "ok"), eq("output.box", "complete")])),
  check("unreadable_store_not_clean", "Dropbox, which can't be read here, is reported as not audited and nothing is changed", [start("unreadable_store_not_clean", audit("dropbox_unread"))], all(runs([eq("output.dropbox", "not_audited"), agent("dropbox-links", "skipped")]), runs([action("slack.post_audit", "applied")]), runs(NO_CHANGES))),
  check("box_auth_failure_not_clean", "If Box refuses the token, Box is reported as not audited and nothing is changed", [start("box_auth_failure_not_clean", audit("box_auth"))], all(runs([eq("output.box", "not_audited"), agent("box-links", "failed")]), runs([action("slack.post_audit", "applied")]), runs(NO_CHANGES)), { fault: { provider: "box", scenario: "auth_failure", evidence: "refusal" } }),
  check("duplicate_audit", "A re-delivered audit trigger finds the same run and posts one summary", [start("duplicate_audit", audit("duplicate")), startAgain("duplicate_audit", audit("duplicate"))], runs([action("slack.post_audit", "applied", 1, [eq("attempts", 1)])])),
  check("concurrent_audits", "Four simultaneous triggers post one summary", [start("concurrent_audits", audit("concurrent")), startAgain("concurrent_audits", audit("concurrent"), 1, 4)], runs([action("slack.post_audit", "applied", 1, [eq("attempts", 1)])])),
  check("invalid_input_rejected", "An audit id outside the SHARE- format is rejected before any agent runs", [start("invalid_input_rejected", { auditId: "weekly", approvers: [] }, { expectStatus: 400 })], runs([], 0)),
  check("slack_rate_limited", "Slack rate limiting fails the summary visibly", [start("slack_rate_limited", audit("slack_rl"))], runs([action("slack.post_audit", "failed")]), { fault: { provider: "slack", scenario: "rate_limited", evidence: "refusal" } }),
  check("restart_then_redelivery", "After a runtime restart, a re-delivered trigger finds the saved run and repeats nothing", [start("restart_then_redelivery", audit("restart")), restart, startAgain("restart_then_redelivery", audit("restart"))], all(runs([eq("phase", "DONE")]), runs([action("slack.post_audit", "applied", 1, [eq("attempts", 1)])]))),
  blocked("sensitive_public_restricted", "A public link to a sensitive item (payroll, customer export) is restricted to the company", "setup_missing", "A public Box link can't be staged on a session item, and the Box tree can't be read.", BOX_TD),
  blocked("expiry_capped", "A public link with no expiry, or past the maximum, gets the policy's maximum expiry", "setup_missing", "Same Box twin divergences.", BOX_TD),
  blocked("exempt_and_restricted_left_alone", "Exempt folders, company-only and password links are left alone", "setup_missing", "Same Box twin divergences.", BOX_TD),
  blocked("change_since_sweep_respected", "A link fixed or replaced after the sweep is not changed again", "setup_missing", "Needs a link whose state the contract can change between planning and approval (external-operator input on Box) and a readable Box tree.", [...BOX_TD, "Box shared-link updates aren't qualified external-operator inputs"]),
  blocked("revoke_needs_approval", "Revocation and changes past the per-run limit wait for a security approver", "setup_missing", "Needs findings, which need a readable Box tree with staged public links.", BOX_TD),
  blocked("dropbox_links_enforced", "Dropbox shared links are listed (cursor paging) and narrowed with modify_shared_link_settings", "setup_missing", "No Dropbox twin.", NO_DROPBOX),
];

export default {
  workflow: "external-sharing-audit",
  providers: ["slack", "box"],
  context: {
    goal: "Prove the external-sharing-audit AgentCore runtime: inventory Box and Dropbox shared links, apply the sharing policy (restrict sensitive public links, cap public-link expiry, skip exempt paths), re-read each link before changing it, gate revocations and over-limit changes on a security approver, and report a store it couldn't read as not audited.",
    workflow: "POST /invocations {action:start, input:{auditId, approvers}}; {action:decide} for gated changes. Policy: policies/external-sharing-audit.json.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["revoke_needs_approval"],
    schema_and_value_boundaries: ["invalid_input_rejected", "exempt_and_restricted_left_alone"],
    amount_currency_quantity: "No amounts; the per-run automatic change limit is covered by revoke_needs_approval.",
    duplicate_replay: ["duplicate_audit", "restart_then_redelivery"],
    concurrency: ["concurrent_audits"],
    ordering_and_stale_events: ["change_since_sweep_respected"],
    delayed_or_missing_events: "A scheduled sweep; a missed trigger is caught by the next sweep.",
    provider_auth_and_scopes: ["box_auth_failure_not_clean", "unreadable_store_not_clean"],
    rate_limit_server_error_timeout: ["slack_rate_limited"],
    accepted_effect_response_loss: "Each change re-reads the link and skips one already narrowed, so a lost response is harmless on resume; covered locally.",
    partial_effects_and_recovery: ["box_auth_failure_not_clean"],
    restart_and_durability: ["restart_then_redelivery"],
    reconciliation: ["box_links_inventoried", "change_since_sweep_respected"],
    cancellation_refund_entitlements: "No cancellations or refunds.",
    data_and_privacy_boundaries: ["sensitive_public_restricted", "expiry_capped", "dropbox_links_enforced"],
    cleanup_and_isolation: ["baseline", "concurrent_audits"],
  },
  evidence: ["acme-ops/src/workflows/external-sharing-audit.ts", "acme-ops/policies/external-sharing-audit.json", "acme-ops/src/providers/storage.ts", "acme-ops/src/providers/work.ts BoxClient", "acme-ops/src/kit/engine.ts"],
};
