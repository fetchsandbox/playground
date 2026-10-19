import { action, agent, all, blocked, check, command, eq, noAction, restart, runs, start } from "./lib.mjs";

// Fixtures are seeded per check by seed(): a HubSpot contact, a Stripe customer
// and a WorkOS user for dsr-<check>@privacy.test (some checks hold back one of
// them, or add a live subscription), so no two checks share a data subject.
const CHANNEL = "C0BILLING01";
const DPO = "U_DPO";
const RECEIVED = "2026-10-15T09:00:00Z";

const email = (caseId) => `dsr-${caseId.replaceAll("_", "-")}@privacy.test`;
const request = (caseId, over = {}) => ({
  requestId: `DSR-${caseId.replaceAll("_", "-")}`.slice(0, 64),
  subject: { email: email(caseId), name: "Erin Example" },
  regulation: "gdpr",
  receivedAt: RECEIVED,
  verification: { method: "email_link", verifiedBy: "privacy-portal" },
  privacyChannel: CHANNEL,
  approvers: [DPO],
  ...over,
});
const erasures = ["hubspot.erase_contact", "stripe.anonymize_customer", "workos.delete_user"];
const parkedAll = [...erasures, "gmail.draft_completion"].map((id) => action(id, "pending_approval"));

function faulted(id, name, provider, scenario, assertions) {
  return check(id, name, [start(id, request(id))], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });
}

/** Which records each check's data subject has. */
const ALL = { hubspot: true, stripe: true, workos: true };
const FIXTURES = {
  baseline: ALL,
  approve_erases: ALL,
  rejected: ALL,
  approve_by_stranger_refused: ALL,
  unverified_no_erasure: ALL,
  active_subscription_retains_billing: { ...ALL, subscription: true },
  crm_only: { hubspot: true },
  duplicate_start: ALL,
  concurrent_start: ALL,
  workos_auth_failure: ALL,
  hubspot_rate_limited: ALL,
  stripe_auth_failure: ALL,
  slack_rate_limited: ALL,
  restart_while_parked: ALL,
};

export const checks = [
  check("baseline", "A verified request finds the subject in all three systems, records it against the deadline, and parks every erasure for approval", [start("baseline", request("baseline"))], runs([eq("phase", "AWAITING_APPROVAL"), action("asana.dsar_record", "applied"), action("slack.post_dsr", "applied"), ...parkedAll])),
  check(
    "approve_erases",
    "Approval deletes the login account, anonymizes the billing customer and drafts the response; reconcile reads both back",
    [start("approve_erases", request("approve_erases")), command("decide", 1, { decision: "approve", userId: DPO }), command("reconcile", 1)],
    runs([eq("phase", "DONE"), action("hubspot.erase_contact", "applied"), action("stripe.anonymize_customer", "applied", 1, [eq("reconciled", "match")]), action("workos.delete_user", "applied", 1, [eq("reconciled", "match")]), action("gmail.draft_completion", "applied")]),
  ),
  check("rejected", "A rejected request erases nothing", [start("rejected", request("rejected")), command("decide", 1, { decision: "reject", userId: DPO })], runs([eq("phase", "REJECTED"), ...erasures.map((id) => action(id, "rejected"))])),
  check("approve_by_stranger_refused", "Someone who is not the DPO cannot approve erasure", [start("approve_by_stranger_refused", request("approve_by_stranger_refused")), command("decide", 1, { decision: "approve", userId: "U_SUPPORT" }, 403)], runs([eq("phase", "AWAITING_APPROVAL"), action("workos.delete_user", "pending_approval")])),
  check("unverified_no_erasure", "An unverified request erases nothing and drafts a verification request", [start("unverified_no_erasure", request("unverified_no_erasure", { verification: { method: "none", verifiedBy: "inbox" } }))], runs([eq("phase", "DONE"), action("gmail.draft_verification_request", "applied"), ...erasures.map(noAction)])),
  check("active_subscription_retains_billing", "An active subscription holds the billing record; CRM and login are still erased on approval", [start("active_subscription_retains_billing", request("active_subscription_retains_billing"))], runs([eq("phase", "AWAITING_APPROVAL"), noAction("stripe.anonymize_customer"), action("hubspot.erase_contact", "pending_approval"), action("workos.delete_user", "pending_approval")])),
  check("crm_only", "A subject found only in the CRM gets only the CRM erasure", [start("crm_only", request("crm_only"))], runs([action("hubspot.erase_contact", "pending_approval"), noAction("stripe.anonymize_customer"), noAction("workos.delete_user")])),
  check("nothing_held", "A subject found nowhere gets the response drafted with no approval needed", [start("nothing_held", request("nothing_held"))], runs([eq("phase", "DONE"), ...erasures.map(noAction), action("gmail.draft_completion", "applied", 1, [eq("gate", "auto")])])),
  check("duplicate_start", "A re-delivered request records once", [start("duplicate_start", request("duplicate_start")), start("duplicate_start", request("duplicate_start"))], runs([action("asana.dsar_record", "applied", 1, [eq("attempts", 1)])])),
  check("concurrent_start", "Four simultaneous deliveries of one request record once", [start("concurrent_start", request("concurrent_start")), { ...start("concurrent_start", request("concurrent_start")), concurrency: 4 }], runs([action("asana.dsar_record", "applied", 1, [eq("attempts", 1)])])),
  check("invalid_input_rejected", "A request without a valid request id is rejected before any agent runs", [start("invalid_input_rejected", request("invalid_input_rejected", { requestId: "x" }), { expectStatus: 400 })], runs([], 0)),
  faulted("workos_auth_failure", "With the directory unreachable the request stays open: no response is drafted, found records still park for erasure", "workos", "auth_failure", [agent("identity-records", "failed"), noAction("gmail.draft_completion"), action("hubspot.erase_contact", "pending_approval")]),
  faulted("hubspot_rate_limited", "With the CRM rate limited the request stays open and the other systems still park", "hubspot", "rate_limited", [agent("crm-records", "failed"), noAction("gmail.draft_completion"), action("workos.delete_user", "pending_approval")]),
  faulted("stripe_auth_failure", "With billing unreachable nothing billing-related is changed", "stripe", "auth_failure", [agent("billing-records", "failed"), noAction("stripe.anonymize_customer"), noAction("gmail.draft_completion")]),
  faulted("slack_rate_limited", "Slack rate limiting fails the channel post only", "slack", "rate_limited", [action("slack.post_dsr", "failed"), action("asana.dsar_record", "applied")]),
  check("restart_while_parked", "Erasures parked for approval survive a real runtime restart and run once when approved", [start("restart_while_parked", request("restart_while_parked")), restart, command("decide", 1, { decision: "approve", userId: DPO })], runs([eq("phase", "DONE"), action("workos.delete_user", "applied", 1, [eq("attempts", 1)]), action("stripe.anonymize_customer", "applied", 1, [eq("attempts", 1)])])),
  blocked("crm_erasure_readback", "Reconcile confirms the HubSpot contact is gone after the GDPR delete", "observation_missing", "The HubSpot twin accepts POST /crm/v3/objects/contacts/gdpr-delete but keeps the contact, so the read-back reports drift on the twin.", ["acme-ops/src/workflows/privacy-erasure.ts hubspot.erase_contact reconcile", "GET /crm/v3/objects/contacts/{id} after gdpr-delete → 200 on the twin"]),
  blocked("privileged_account_flagged", "An account holding admin roles is flagged for security sign-off", "setup_missing", "The WorkOS twin doesn't list a user's memberships (GET /user_management/organization_memberships?user_id returns a sample object) or keep role slugs. Covered by local tests.", ["acme-ops/src/workflows/privacy-erasure.ts identity-records", "GET /user_management/organization_memberships?user_id=… on the twin"]),
  blocked("hold_rechecked_at_write", "A subscription started after discovery blocks anonymization and the response", "setup_missing", "Needs a write to the twin between start and approval of one run. Covered by local tests.", ["acme-ops/src/workflows/privacy-erasure.ts stripe.anonymize_customer execute"]),
];

/** A data subject per check across HubSpot, Stripe and WorkOS. */
async function seed(legs, log) {
  const post = async (leg, path, { form, json }) => {
    const res = await fetch(`${leg.base_url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${leg.api_key}`, "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
      body: form ? new URLSearchParams(form).toString() : JSON.stringify(json),
    });
    const body = await res.json();
    if (!res.ok || !body.id) throw new Error(`seed ${path} → ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
    return body;
  };
  const out = {};
  for (const [caseId, has] of Object.entries(FIXTURES)) {
    const e = email(caseId);
    const rec = {};
    if (has.hubspot) rec.hubspot = (await post(legs.hubspot, "/crm/v3/objects/contacts", { json: { properties: { email: e, firstname: "Erin" } } })).id;
    if (has.stripe) {
      rec.stripe = (await post(legs.stripe, "/v1/customers", { form: { email: e, name: "Erin Example", phone: "+15550100" } })).id;
      if (has.subscription) rec.subscription = (await post(legs.stripe, "/v1/subscriptions", { form: { customer: rec.stripe, "items[0][price]": "price_1Pro_Monthly_USD" } })).id;
    }
    if (has.workos) rec.workos = (await post(legs.workos, "/user_management/users", { json: { email: e, first_name: "Erin" } })).id;
    out[caseId] = rec;
  }
  log("seed", Object.keys(out).length, "data subjects");
  return out;
}

export default {
  workflow: "privacy-erasure",
  providers: ["hubspot", "stripe", "workos", "gmail", "slack", "asana"],
  seed,
  context: {
    goal: "Prove the privacy-erasure AgentCore runtime: GDPR/CCPA erasure request → parallel discovery in HubSpot, Stripe and WorkOS → per-system decision (erase, anonymize, retain under a legal hold) → Asana record with the statutory deadline and Slack post (hashed subject) → approval-gated HubSpot GDPR delete, Stripe anonymization and WorkOS deletion → response draft only after the erasures.",
    workflow: "POST /invocations {action:start} discovers and plans, recording the request and parking erasures; {action:decide} approves or rejects; {action:reconcile} reads erasures back. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["approve_by_stranger_refused", "unverified_no_erasure", "privileged_account_flagged"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: "No amounts: erasure moves no money.",
    duplicate_replay: ["duplicate_start"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: ["hold_rechecked_at_write"],
    delayed_or_missing_events: "The request trigger carries everything; nothing waits on provider events.",
    provider_auth_and_scopes: ["workos_auth_failure", "stripe_auth_failure"],
    rate_limit_server_error_timeout: ["hubspot_rate_limited", "slack_rate_limited"],
    accepted_effect_response_loss: "Each erasure is claimed in the run store before it runs; HubSpot GDPR delete and WorkOS delete are idempotent by id. Covered by local tests.",
    partial_effects_and_recovery: ["workos_auth_failure", "hubspot_rate_limited"],
    restart_and_durability: ["restart_while_parked"],
    reconciliation: ["approve_erases", "crm_erasure_readback"],
    cancellation_refund_entitlements: ["rejected", "active_subscription_retains_billing"],
    data_and_privacy_boundaries: ["baseline", "crm_only", "nothing_held"],
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: ["acme-ops/src/workflows/privacy-erasure.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/providers/{hubspot,stripe,google,slack,work}.ts"],
};
