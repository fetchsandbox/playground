import { action, actionKind, agent, all, check, command, eq, runs, start } from "./lib.mjs";

// Executable expectations for a data subject access request export (Kit v2
// signals and deadline timers). HubSpot, Stripe, Zendesk, Box, Gmail, Asana and
// Slack have FetchSandbox twins. seed() creates each check's data subject in
// HubSpot, Stripe and Zendesk; what a twin refuses is recorded, not hidden.
const PRIVACY = "C0PRIVACY01";
// Received at proof time, so the statutory deadline (and its escalation) is 27+ days away unless the verifier moves the clock.
const RECEIVED = new Date().toISOString();
const email = (c) => `subject-${c.replaceAll("_", "-")}@dsar.example`;
const input = (c, over = {}) => ({ requestId: `DSAR-${c.replaceAll("_", "-")}`.slice(0, 45), subject: { email: email(c), name: "Sam Subject" }, regulation: "gdpr", receivedAt: RECEIVED, privacyChannel: PRIVACY, exportFolderId: "0", verifiers: ["U_VERIFIER", "U_ANALYST"], analysts: ["U_ANALYST", "U_ANALYST_2"], ...over });
const request = (c, over) => start(c, input(c, over));
const id = (c, k) => `${k}:${input(c).requestId}`;
const verified = (c, by = "U_VERIFIER") => command("signal", 1, { actionId: id(c, "privacy.verify_identity"), value: "approve", userId: by });

export const checks = [
  check("baseline", "An access request is recorded against its statutory deadline", [request("baseline")], runs([action("asana.dsar_record", "applied")])),
  check("discovery_complete", "The subject is found in CRM, billing and support, and the request waits for identity", [request("discovery_complete")], runs([agent("crm", "ok"), agent("billing", "ok"), agent("support", "ok"), eq("output.mode", "export"), action(id("discovery_complete", "privacy.verify_identity"), "awaiting_signal")])),
  check("verified_export_uploaded", "Once identity is confirmed the export is assembled and uploaded to Box", [request("verified_export_uploaded"), verified("verified_export_uploaded")], runs([action(id("verified_export_uploaded", "box.upload_export"), "applied")])),
  check("verifier_cannot_release", "Whoever confirmed identity can't also release the export", [request("verifier_cannot_release"), verified("verifier_cannot_release", "U_ANALYST"), command("signal", 2, { actionId: id("verifier_cannot_release", "privacy.approve_export"), value: "approve", userId: "U_ANALYST" }, 403)], runs([action(id("verifier_cannot_release", "privacy.approve_export"), "awaiting_signal")])),
  check("release_drafts_response", "A second analyst's release creates an expiring link and a response draft (not sent)", [request("release_drafts_response"), verified("release_drafts_response"), command("signal", 2, { actionId: id("release_drafts_response", "privacy.approve_export"), value: "approve", userId: "U_ANALYST_2" })], runs([action(id("release_drafts_response", "box.share_link"), "applied"), action(id("release_drafts_response", "gmail.draft_response"), "applied")])),
  check("deadline_escalation", "A request still open three days before the deadline is escalated (needs clock control)", [request("deadline_escalation"), { method: "POST", path: "/invocations", body: { action: "tick" }, expect_status: 200 }], runs([action(id("deadline_escalation", "privacy.escalate"), "applied")])),
  check("support_unavailable_blocks", "When support can't be searched nothing is exported and privacy-ops is told", [request("support_unavailable_blocks")], all(runs([agent("support", "failed"), eq("output.mode", "blocked"), actionKind("box.upload_export", null, 0), action("slack.post_blocked", "applied")])), { fault: { provider: "zendesk", scenario: "rate_limited", evidence: "refusal" } }),
  check("invalid_input_rejected", "A malformed request id is rejected before any agent runs", [start("invalid_input_rejected", { ...input("baseline"), requestId: "please send my data" }, { expectStatus: 400 })], runs([], 0)),
];

async function seed(legs, log) {
  const trail = [];
  const post = async (leg, path, body, form = false) => {
    const res = await fetch(`${leg.base_url}${path}`, { method: "POST", headers: { authorization: `Bearer ${leg.api_key}`, "content-type": form ? "application/x-www-form-urlencoded" : "application/json" }, body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) trail.push(`${path} ${res.status} ${text.slice(0, 300)}`);
    return res.ok;
  };
  let made = 0;
  for (const chk of checks) {
    if (chk.id === "invalid_input_rejected") continue;
    const e = email(chk.id);
    made += await post(legs.hubspot, "/crm/v3/objects/contacts", { properties: { email: e, firstname: "Sam" } });
    made += await post(legs.stripe, "/v1/customers", { email: e, name: "Sam Subject" }, true);
    made += await post(legs.zendesk, "/api/v2/tickets.json", { ticket: { subject: "Billing question", comment: { body: "Why was I charged twice?" }, requester: { email: e, name: "Sam Subject" } } });
  }
  log("seed", made, "records;", trail.slice(0, 6).join("; "));
  return { made, trail };
}

export default {
  workflow: "dsar-export",
  providers: ["hubspot", "stripe", "zendesk", "box", "gmail", "asana", "slack"],
  seed,
  context: {
    goal: "Prove the dsar-export AgentCore runtime: a GDPR/CCPA access request → parallel discovery in HubSpot, Stripe and Zendesk (references only) → identity confirmed by a privacy team member (signal) → export assembled from source systems and uploaded once to Box → released by an analyst other than the verifier (signal) → expiring Box link in a Gmail draft (not sent); reminder 10 days and escalation 3 days before the statutory deadline unless drafted. Incomplete discovery exports nothing.",
    workflow: "POST /invocations {action:start}; {action:signal} for identity and release; {action:tick} fires reminders and escalation. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["verified_export_uploaded", "verifier_cannot_release"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: "No money moves.",
    duplicate_replay: "The export is looked up by name in the folder before uploading (local tests).",
    concurrency: "Signals are compare-and-swap on the run.",
    ordering_and_stale_events: ["verifier_cannot_release"],
    delayed_or_missing_events: ["deadline_escalation"],
    provider_auth_and_scopes: ["support_unavailable_blocks"],
    rate_limit_server_error_timeout: ["support_unavailable_blocks"],
    accepted_effect_response_loss: "Upload is idempotent by folder and file name.",
    partial_effects_and_recovery: ["support_unavailable_blocks"],
    restart_and_durability: "Signals and deadline timers survive restarts (Kit v2 tests).",
    reconciliation: "The uploaded export reconciles against Box by file id.",
    cancellation_refund_entitlements: "No entitlements change.",
    data_and_privacy_boundaries: ["discovery_complete", "release_drafts_response"],
    cleanup_and_isolation: ["baseline"],
  },
  evidence: ["acme-ops/src/workflows/dsar-export.ts", "acme-ops/test/dsar-export.test.ts"],
};
