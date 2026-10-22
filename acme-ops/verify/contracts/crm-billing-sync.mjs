import { action, actionKind, agent, all, check, eq, runs, start } from "./lib.mjs";

// Executable expectations for the CRM ↔ billing sync (field ownership, link
// conflicts, mass-change and per-run write guards). Stripe, HubSpot and Slack
// have FetchSandbox twins. seed() creates each check's segment: Stripe
// customers tagged metadata[acme_segment], and HubSpot contacts in the state
// the check needs. Without subscriptions every customer bills plan "none",
// MRR 0, status "none", which is what in-sync contacts are seeded with.
const REVOPS = "C0REVOPS001";
const seg = (c) => `cbs-${c.replaceAll("_", "-")}`.slice(0, 60);
const sync = (c, over = {}) => start(c, { syncId: `SYNC-${c.replaceAll("_", "-")}`.slice(0, 45), segment: seg(c), revopsChannel: REVOPS, ...over });
const SYNCED = { acme_plan: "none", acme_mrr: "0", acme_billing_status: "none" };
const STALE = { acme_plan: "price_retired", acme_mrr: "4900", acme_billing_status: "active" };
/** Per check: customers, each with the contact to create (null = none). "self" links the contact to its own customer. */
const FIXTURES = {
  baseline: [{ contact: {} }],
  matched_by_email_linked: [{ contact: {} }],
  in_sync_not_rewritten: [{ contact: { link: "self", ...SYNCED } }],
  conflict_never_overwritten: [{ contact: { link: "cus_someone_else" } }],
  unmatched_reported: [{ contact: null }],
  auto_limit_respected: [{ contact: {} }, { contact: {} }, { contact: {} }],
  mass_change_needs_approval: Array.from({ length: 21 }, () => ({ contact: { link: "self", ...STALE } })),
  stripe_rate_limited: [{ contact: {} }],
};

export const checks = [
  check("baseline", "A segment sync reads billing, matches contacts and posts a summary", [sync("baseline")], runs([agent("billing", "ok"), eq("output.mode", "sync"), action("slack.post_sync", "applied")])),
  check("matched_by_email_linked", "A contact found by email is linked to its customer and given plan, MRR and status", [sync("matched_by_email_linked")], runs([eq("output.writes", 1), actionKind("hubspot.sync", "applied")])),
  check("in_sync_not_rewritten", "A contact that already matches billing is not written", [sync("in_sync_not_rewritten")], runs([eq("output.inSync", 1), actionKind("hubspot.sync", null, 0)])),
  check("conflict_never_overwritten", "A contact linked to another customer is reported, never overwritten", [sync("conflict_never_overwritten")], runs([eq("output.conflicts", 1), actionKind("hubspot.sync", null, 0)])),
  check("unmatched_reported", "A customer with no contact is counted, not created", [sync("unmatched_reported")], runs([eq("output.unmatched", 1), actionKind("hubspot.sync", null, 0)])),
  check("auto_limit_respected", "Past the run's automatic limit (1), writes wait for approval", [sync("auto_limit_respected", { maxAutoWrites: 1 })], runs([actionKind("hubspot.sync", "applied", 1), actionKind("hubspot.sync", "pending_approval", 2)])),
  check("mass_change_needs_approval", "A run that would change most of the segment at once applies nothing without approval", [sync("mass_change_needs_approval")], runs([actionKind("hubspot.sync", "pending_approval", 21), actionKind("hubspot.sync", "applied", 0)])),
  check("stripe_rate_limited", "When billing can't be read nothing is written", [sync("stripe_rate_limited")], all(runs([agent("billing", "failed"), eq("output.mode", "blocked"), actionKind("hubspot.sync", null, 0)])), { fault: { provider: "stripe", scenario: "rate_limited", evidence: "refusal" } }),
  check("invalid_input_rejected", "A segment with spaces is rejected before any agent runs", [start("invalid_input_rejected", { syncId: "SYNC-bad", segment: "all customers", revopsChannel: REVOPS }, { expectStatus: 400 })], runs([], 0)),
];

async function seed(legs, log) {
  const trail = [];
  const call = async (leg, path, body, form = false) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${leg.base_url}${path}`, { method: "POST", headers: { authorization: `Bearer ${leg.api_key}`, "content-type": form ? "application/x-www-form-urlencoded" : "application/json" }, body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      if (res.ok && json) return json;
      if ((res.status >= 500 || !json) && attempt < 3) { trail.push(`${path} ${res.status} retried`); await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
      trail.push(`${path} ${res.status} ${text.slice(0, 80)}`);
      return null;
    }
  };
  let made = 0;
  for (const [c, rows] of Object.entries(FIXTURES)) {
    for (const [i, row] of rows.entries()) {
      const email = `${seg(c)}-${i}@sync.example`;
      const cus = await call(legs.stripe, "/v1/customers", { email, name: `Sync ${i}`, "metadata[acme_segment]": seg(c) }, true);
      if (!cus?.id) continue;
      made++;
      if (!row.contact) continue;
      const { link, ...props } = row.contact;
      if (await call(legs.hubspot, "/crm/v3/objects/contacts", { properties: { email, ...props, ...(link ? { acme_stripe_customer_id: link === "self" ? cus.id : link } : {}) } })) made++;
    }
  }
  log("seed", made, "records;", trail.slice(0, 6).join("; "));
  return { made, trail };
}

export default {
  workflow: "crm-billing-sync",
  providers: ["stripe", "hubspot", "slack"],
  seed,
  context: {
    goal: "Prove the crm-billing-sync AgentCore runtime: every Stripe customer in a segment (metadata.acme_segment) → plan, MRR (annual normalized to monthly) and billing status from live subscriptions → matched to its HubSpot contact by link or email → billing-owned fields written; contacts linked to another customer are conflicts and never overwritten; runs that would change most of the segment, or exceed the per-run automatic limit, wait for approval; each write re-reads the contact's link.",
    workflow: "POST /invocations {action:start} syncs one segment; {action:decide} releases writes held for approval. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["conflict_never_overwritten"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: ["matched_by_email_linked"],
    duplicate_replay: ["in_sync_not_rewritten"],
    concurrency: "Each write re-reads the contact and refuses a changed link (local tests).",
    ordering_and_stale_events: ["conflict_never_overwritten"],
    delayed_or_missing_events: "The hourly schedule re-drives the sync; a missed run is caught by the next.",
    provider_auth_and_scopes: ["stripe_rate_limited"],
    rate_limit_server_error_timeout: ["stripe_rate_limited"],
    accepted_effect_response_loss: "Writes are idempotent property sets.",
    partial_effects_and_recovery: ["auto_limit_respected", "mass_change_needs_approval"],
    restart_and_durability: "The billing scan is checkpointed (local tests).",
    reconciliation: "Each write reconciles against the contact's fields.",
    cancellation_refund_entitlements: "No billing state changes; the CRM follows billing.",
    data_and_privacy_boundaries: ["unmatched_reported"],
    cleanup_and_isolation: ["baseline"],
  },
  evidence: ["acme-ops/src/workflows/crm-billing-sync.ts", "acme-ops/test/crm-billing-sync.test.ts"],
};
