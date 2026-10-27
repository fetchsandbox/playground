import { action, actionKind, agent, all, check, eq, runs, start, asCase, proofNow } from "./lib.mjs";

// Executable expectations for consent propagation (event-time ordering guard,
// read-back verification on a Kit v2 delayAfter timer). HubSpot, Stripe and
// Slack have FetchSandbox twins. seed() creates each check's subject: one
// HubSpot contact, a marketing subscription, and Stripe customers. Whatever a
// twin refuses (custom properties, the subscription API) is recorded.
const PRIVACY = "C0PRIVACY01";
const SUBSCRIPTION = "4242";
const NOW = new Date(proofNow()).toISOString();
const LATER = new Date(proofNow() + 3_600_000).toISOString();
const email = (c) => `consent-${c.replaceAll("_", "-")}@pref.example`;
const input = (c, over = {}) => ({ eventId: `evt_${c}`.slice(0, 68), email: email(c), occurredAt: NOW, source: "preference_center", changes: [{ purpose: "marketing_email", state: "withdrawn" }, { purpose: "sale_or_share", state: "withdrawn" }], marketingSubscriptionId: SUBSCRIPTION, privacyChannel: PRIVACY, ...over });
const change = (c, over) => start(c, input(c, over));
const FIXTURES = {
  baseline: {},
  subscription_turned_off: {},
  every_customer_updated: { customers: 2 },
  stale_event_ignored: { newer: true },
  replay_changes_nothing: {},
  verified_after_15_minutes: {},
  hubspot_rate_limited: {},
};

export const checks = [
  check("baseline", "A request starts one recorded run (provider-independent, so every later check is measured)", [change("baseline")], runs([], 1)),
  // Until 2026-10-22 this was the baseline; moved so a missing or divergent twin fails only this check.
  check("baseline_effects", "A withdrawal is written to the HubSpot contact with its event time", [asCase("baseline_effects", change("baseline"))], runs([agent("crm", "ok"), eq("output.mode", "propagate"), actionKind("hubspot.consent", "applied")])),
  check("subscription_turned_off", "Marketing email withdrawal unsubscribes the address in HubSpot", [change("subscription_turned_off")], runs([action(`hubspot.subscription:${SUBSCRIPTION}`, "applied")])),
  check("every_customer_updated", "Every Stripe customer with the address carries the withdrawal", [change("every_customer_updated")], runs([eq("output.customers", 2), actionKind("stripe.consent", "applied", 2)])),
  check("stale_event_ignored", "An event older than the consent on record changes nothing", [change("stale_event_ignored")], runs([actionKind("hubspot.consent", "skipped")])),
  check("replay_changes_nothing", "The same event delivered again writes nothing", [change("replay_changes_nothing"), start("replay_changes_nothing", input("replay_changes_nothing"), { runId: "replay-b-{{run_id}}" })], all(runs([], 2), runs([actionKind("hubspot.consent", "skipped"), actionKind("stripe.consent", "skipped")]))),
  check("verified_after_15_minutes", "Fifteen minutes later every system is read back and agrees (needs clock control)", [change("verified_after_15_minutes"), { method: "POST", path: "/invocations", body: { action: "tick" }, expect_status: 200 }], runs([action("consent.verify", "applied", 1, [eq("ref", "verified")])])),
  check("hubspot_rate_limited", "When HubSpot can't be read, billing is still updated and privacy-ops is told", [change("hubspot_rate_limited")], all(runs([agent("crm", "failed"), eq("output.mode", "partial"), actionKind("stripe.consent", "applied"), action("slack.post_consent", "applied")])), { fault: { provider: "hubspot", scenario: "rate_limited", evidence: "refusal" } }),
  check("invalid_input_rejected", "An unknown purpose is rejected before any agent runs", [start("invalid_input_rejected", { ...input("baseline"), changes: [{ purpose: "everything", state: "withdrawn" }] }, { expectStatus: 400 })], runs([], 0)),
];

async function seed(legs, log) {
  const trail = [];
  const call = async (leg, method, path, body, form = false) => {
    const res = await fetch(`${leg.base_url}${path}`, { method, headers: { authorization: `Bearer ${leg.api_key}`, "content-type": form ? "application/x-www-form-urlencoded" : "application/json" }, body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) trail.push(`${method} ${path} ${res.status} ${text.slice(0, 300)}`);
    return res.ok;
  };
  // HubSpot rejects undefined custom properties; production setup defines them once (CRM Properties API).
  for (const name of ['acme_consent_marketing_email', 'acme_consent_sale_or_share', 'acme_consent_profiling', 'acme_consent_last_event']) {
    const res = await fetch(`${legs.hubspot.base_url}/crm/v3/properties/contacts`, { method: "POST", headers: { authorization: `Bearer ${legs.hubspot.api_key}`, "content-type": "application/json" }, body: JSON.stringify({ name, label: name, type: "string", fieldType: "text", groupName: "contactinformation" }) });
    if (!res.ok && res.status !== 409) trail.push(`define property ${name}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  let made = 0;
  for (const [c, f] of Object.entries(FIXTURES)) {
    const e = email(c);
    const props = { email: e, ...(f.newer ? { acme_consent_marketing_email: `granted@${LATER}`, acme_consent_sale_or_share: `granted@${LATER}` } : {}) };
    made += await call(legs.hubspot, "POST", "/crm/v3/objects/contacts", { properties: props });
    made += await call(legs.hubspot, "POST", "/communication-preferences/v3/subscribe", { emailAddress: e, subscriptionId: SUBSCRIPTION, legalBasis: "CONSENT_WITH_NOTICE", legalBasisExplanation: "seed" });
    for (let i = 0; i < (f.customers ?? 1); i++) made += await call(legs.stripe, "POST", "/v1/customers", { email: e, name: `Subject ${i}` }, true);
  }
  log("seed", made, "records;", trail.slice(0, 6).join("; "));
  return { made, trail };
}

export default {
  workflow: "consent-propagation",
  providers: ["hubspot", "stripe", "slack"],
  seed,
  context: {
    goal: "Prove the consent-propagation AgentCore runtime: a preference-center consent change → HubSpot contact property per purpose (state@event time) and the marketing email subscription, plus every Stripe customer with the address; stale events never overwrite newer consent, replays write nothing; 15 minutes later every system is read back, re-applied once and a persistent mismatch escalated to privacy-ops.",
    workflow: "POST /invocations {action:start} applies the change; {action:tick} runs the read-back. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline", "baseline_effects"],
    identity_and_access: "Consent is keyed by the verified email from the preference center.",
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: ["every_customer_updated"],
    duplicate_replay: ["replay_changes_nothing"],
    concurrency: "Each write re-reads the stored event time first (local tests).",
    ordering_and_stale_events: ["stale_event_ignored"],
    delayed_or_missing_events: ["verified_after_15_minutes"],
    provider_auth_and_scopes: ["hubspot_rate_limited"],
    rate_limit_server_error_timeout: ["hubspot_rate_limited"],
    accepted_effect_response_loss: "Writes are idempotent property sets checked by read-back.",
    partial_effects_and_recovery: ["hubspot_rate_limited"],
    restart_and_durability: "The read-back timer survives restarts (Kit v2 tests).",
    reconciliation: ["verified_after_15_minutes"],
    cancellation_refund_entitlements: ["subscription_turned_off"],
    data_and_privacy_boundaries: "Slack posts carry a hash of the address, never the address.",
    cleanup_and_isolation: ["baseline"],
  },
  evidence: ["acme-ops/src/workflows/consent-propagation.ts", "acme-ops/test/consent-propagation.test.ts"],
};
