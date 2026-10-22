import { action, actionKind, agent, all, check, eq, runs, start } from "./lib.mjs";

// Executable expectations for inbound lead routing with a first-touch SLA
// (Kit v2: delayAfter timers, reassign-then-escalate). HubSpot and Slack have
// FetchSandbox twins, so routing should be measurable end to end; the SLA
// timers need the verifier to move the runtime's clock. seed() creates each
// check's lead (and colleagues) through HubSpot's contacts API and swaps
// LEAD_<check> for the real contact id; properties a twin rejects are dropped
// one by one and recorded.
const SALES = "C0SALES0001";
const pod = (ids, mgr) => ({ reps: ids.map((id) => ({ ownerId: id, slackId: `U_REP_${id}` })), managerSlackId: mgr });
const PODS = {
  NA: { enterprise: pod(["11", "12"], "U_MGR_NA_ENT"), commercial: pod(["21", "22", "23"], "U_MGR_NA_COM") },
  EMEA: { enterprise: pod(["31"], "U_MGR_EMEA_ENT"), commercial: pod(["41", "42"], "U_MGR_EMEA_COM") },
  APAC: { enterprise: pod(["51"], "U_MGR_APAC"), commercial: pod(["61"], "U_MGR_APAC") },
};
const FIXTURES = {
  baseline: { lead: { country: "DE", numberofemployees: "300" } },
  least_loaded_rep_assigned: { lead: { country: "DE", numberofemployees: "300" }, load: { "41": 2 } },
  enterprise_lead_one_hour_sla: { lead: { country: "US", numberofemployees: "5000" } },
  account_owner_wins: { lead: { country: "DE", numberofemployees: "300" }, colleague: "41" },
  owned_lead_not_rerouted: { lead: { country: "DE", numberofemployees: "300", hubspot_owner_id: "99" } },
  missed_sla_reassigns: { lead: { country: "DE", numberofemployees: "300" } },
  hubspot_unreadable_blocks: { lead: { country: "DE" } },
  slack_rate_limited: { lead: { country: "DE", numberofemployees: "300" } },
};
const lead = (c) => `LEAD_${c}`;
const routeLead = (c) => start(c, { contactId: lead(c), pods: PODS, regions: { DE: "EMEA", FR: "EMEA", JP: "APAC" }, salesChannel: SALES });

export const checks = [
  check("baseline", "An inbound lead is read and routed to a rep of its territory pod", [routeLead("baseline")], runs([agent("lead", "ok"), eq("output.mode", "route"), eq("output.region", "EMEA"), action(`hubspot.assign:${lead("baseline")}`, "applied")])),
  check("least_loaded_rep_assigned", "The rep with fewer open new leads gets it", [routeLead("least_loaded_rep_assigned")], runs([eq("output.owner", "42"), eq("output.how", "least_loaded")])),
  check("enterprise_lead_one_hour_sla", "A 5,000-employee US lead goes to the NA enterprise pod with a 60-minute SLA", [routeLead("enterprise_lead_one_hour_sla")], runs([eq("output.region", "NA"), eq("output.segment", "enterprise"), eq("output.slaMinutes", 60)])),
  check("account_owner_wins", "A lead from a company we already work with goes to that account's owner", [routeLead("account_owner_wins")], runs([eq("output.owner", "41"), eq("output.how", "account_owner")])),
  check("owned_lead_not_rerouted", "A lead that already has an owner is not re-routed", [routeLead("owned_lead_not_rerouted")], runs([eq("output.mode", "already_owned"), actionKind("hubspot.assign", null, 0)])),
  check("missed_sla_reassigns", "A lead untouched at the SLA is reassigned to the backup rep (needs clock control)", [routeLead("missed_sla_reassigns"), { method: "POST", path: "/invocations", body: { action: "tick" }, expect_status: 200 }], runs([action(`sla.first_touch:${lead("missed_sla_reassigns")}`, "applied")])),
  check("hubspot_unreadable_blocks", "When HubSpot can't be read nothing is assigned and sales is told", [routeLead("hubspot_unreadable_blocks")], all(runs([agent("lead", "failed"), eq("output.mode", "blocked"), actionKind("hubspot.assign", null, 0)])), { fault: { provider: "hubspot", scenario: "rate_limited", evidence: "refusal" } }),
  check("slack_rate_limited", "Slack rate limiting loses the DM only; the lead is still assigned", [routeLead("slack_rate_limited")], all(runs([action(`hubspot.assign:${lead("slack_rate_limited")}`, "applied")])), { fault: { provider: "slack", scenario: "rate_limited", evidence: "refusal" } }),
  check("invalid_input_rejected", "A malformed contact id is rejected before any agent runs", [start("invalid_input_rejected", { contactId: "kim@example.com", pods: PODS, salesChannel: SALES }, { expectStatus: 400 })], runs([], 0)),
];

async function seed(legs, log) {
  const trail = [];
  const create = async (properties) => {
    let props = { ...properties };
    for (;;) {
      const res = await fetch(`${legs.hubspot.base_url}/crm/v3/objects/contacts`, { method: "POST", headers: { authorization: `Bearer ${legs.hubspot.api_key}`, "content-type": "application/json" }, body: JSON.stringify({ properties: props }) });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.id) return body.id;
      // Drop the first property the twin names (or any non-email one) and say so.
      const named = Object.keys(props).find((k) => k !== "email" && JSON.stringify(body).includes(k)) ?? Object.keys(props).find((k) => k !== "email");
      trail.push(`contact ${props.email}: ${res.status} ${(body.message ?? "").slice(0, 300)}${named ? `; dropped ${named}` : ""}`);
      if (!named) throw new Error(`seed contact ${props.email} → ${res.status}`);
      delete props[named];
    }
  };
  const ids = {};
  for (const [c, f] of Object.entries(FIXTURES)) {
    const domain = `${c.replaceAll("_", "-")}.example`;
    ids[c] = await create({ email: `buyer@${domain}`, hs_email_domain: domain, ...f.lead });
    if (f.colleague) await create({ email: `colleague@${domain}`, hs_email_domain: domain, hubspot_owner_id: f.colleague });
    for (const [owner, n] of Object.entries(f.load ?? {})) for (let i = 0; i < n; i++) await create({ email: `open-${owner}-${i}-${c.replaceAll("_", "-")}@load.example`, hubspot_owner_id: owner, hs_lead_status: "NEW" });
  }
  for (const chk of checks) {
    const real = ids[chk.id];
    if (!real) continue;
    for (const a of chk.actions ?? []) if (a.body?.input?.contactId === lead(chk.id)) a.body.input.contactId = real;
    const fix = (where) => where?.forEach((w) => { if (typeof w.equals === "string") w.equals = w.equals.replaceAll(lead(chk.id), real); fix(w.where); });
    const walk = (x) => { if (!x) return; fix(x.where); x.all_of?.forEach(walk); };
    walk(chk.assertion);
  }
  log("seed", Object.keys(ids).length, "leads;", trail.slice(0, 6).join("; "));
  return { ids, trail };
}

export default {
  workflow: "lead-routing-sla",
  providers: ["hubspot", "slack"],
  seed,
  context: {
    goal: "Prove the lead-routing-sla AgentCore runtime: an inbound HubSpot lead → lead read with account-owner lookup by email domain, and open-lead workloads per rep → routed to the account owner or the least-loaded rep of its region × segment pod, DM to the rep; at the first-touch SLA (enterprise 60 min, commercial 240 min) an untouched lead is reassigned and the manager told, a second miss escalates.",
    workflow: "POST /invocations {action:start} routes and starts the SLA timer; {action:tick} fires it. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["account_owner_wins"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: ["least_loaded_rep_assigned", "enterprise_lead_one_hour_sla"],
    duplicate_replay: ["owned_lead_not_rerouted"],
    concurrency: "A lead claimed by someone between read and assignment is left to them (local tests).",
    ordering_and_stale_events: ["owned_lead_not_rerouted"],
    delayed_or_missing_events: ["missed_sla_reassigns"],
    provider_auth_and_scopes: ["hubspot_unreadable_blocks"],
    rate_limit_server_error_timeout: ["hubspot_unreadable_blocks", "slack_rate_limited"],
    accepted_effect_response_loss: "Owner assignment is an idempotent PATCH.",
    partial_effects_and_recovery: ["slack_rate_limited"],
    restart_and_durability: "SLA timers survive restarts (Kit v2 tests).",
    reconciliation: "Assignments reconcile against the contact's owner (local tests).",
    cancellation_refund_entitlements: "No money or entitlements change.",
    data_and_privacy_boundaries: "Slack DMs carry a hash of the lead's email, never the address.",
    cleanup_and_isolation: ["baseline"],
  },
  evidence: ["acme-ops/src/workflows/lead-routing-sla.ts", "acme-ops/test/lead-routing-sla.test.ts"],
};
