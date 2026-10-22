import { action, actionKind, agent, all, check, eq, runs, start, asCase } from "./lib.mjs";

// Executable expectations for the support first-response SLA (Kit v2 timers,
// compare-and-swap ticket claims across overlapping sweeps, de-duplicated
// pages). Zendesk, Slack and PagerDuty have FetchSandbox twins. seed() creates
// each check's tickets in Zendesk, tagged with the check's scope; an agent
// reply is added as a public comment from the API user. Twins can't backdate
// created_at, so every breach needs the verifier to move the runtime's clock.
const SUPPORT = "C0SUPPORT01";
const LEADS = "C0SUPLEADS1";
const scope = (c) => `sla_${c}`.slice(0, 60);
const sweep = (c, over = {}) => start(c, { sweepId: `SLA-${c.replaceAll("_", "-")}`.slice(0, 44), scopeTag: scope(c), supportChannel: SUPPORT, leadsChannel: LEADS, pagerdutyServiceId: "PSUPP01", ...over });
const FIXTURES = {
  baseline: [{ priority: "normal" }],
  unanswered_ticket_timed: [{ priority: "high" }],
  enterprise_tier_detected: [{ priority: "urgent", enterprise: true }],
  answered_ticket_not_timed: [{ priority: "high", reply: true }],
  pending_ticket_paused: [{ priority: "high", status: "pending" }],
  breach_fires_at_target: [{ priority: "urgent" }],
  enterprise_breach_pages: [{ priority: "urgent", enterprise: true }],
  zendesk_rate_limited: [{ priority: "normal" }],
};

export const checks = [
  check("baseline", "A request starts one recorded run (provider-independent, so every later check is measured)", [sweep("baseline")], runs([], 1)),
  // Until 2026-10-22 this was the baseline; moved so a missing or divergent twin fails only this check.
  check("baseline_effects", "A sweep reads the scoped queue and posts a summary", [asCase("baseline_effects", sweep("baseline"))], runs([agent("queue", "ok"), eq("output.mode", "timing"), action("slack.post_sweep", "applied")])),
  check("unanswered_ticket_timed", "An unanswered open ticket gets warning and breach timers", [sweep("unanswered_ticket_timed")], runs([eq("output.awaitingReply", 1), actionKind("sla.warn", "scheduled"), actionKind("sla.breach", "scheduled")])),
  check("enterprise_tier_detected", "A ticket tagged tier_enterprise is timed against the enterprise target and can page", [sweep("enterprise_tier_detected")], runs([eq("output.enterprise", 1), actionKind("pagerduty.page", "scheduled")])),
  check("answered_ticket_not_timed", "A ticket with an agent's public reply has no SLA timer", [sweep("answered_ticket_not_timed")], runs([eq("output.awaitingReply", 0), actionKind("sla.breach", null, 0)])),
  check("pending_ticket_paused", "A ticket waiting on the customer (pending) is not timed", [sweep("pending_ticket_paused")], runs([eq("output.awaitingReply", 0), actionKind("sla.breach", null, 0)])),
  check("breach_fires_at_target", "At the target an unanswered ticket is marked breached and leads are told (needs clock control)", [sweep("breach_fires_at_target"), { method: "POST", path: "/invocations", body: { action: "tick" }, expect_status: 200 }], runs([actionKind("sla.breach", "applied")])),
  check("enterprise_breach_pages", "An enterprise breach pages support on-call once (needs clock control)", [sweep("enterprise_breach_pages"), { method: "POST", path: "/invocations", body: { action: "tick" }, expect_status: 200 }], runs([actionKind("pagerduty.page", "applied")])),
  check("zendesk_rate_limited", "When the queue can't be read, support is told timers aren't running", [sweep("zendesk_rate_limited")], all(runs([agent("queue", "failed"), eq("output.mode", "blocked"), actionKind("sla.breach", null, 0)])), { fault: { provider: "zendesk", scenario: "rate_limited", evidence: "refusal" } }),
  check("invalid_input_rejected", "A malformed PagerDuty service id is rejected before any agent runs", [start("invalid_input_rejected", { sweepId: "SLA-bad", scopeTag: "x_y", supportChannel: SUPPORT, leadsChannel: LEADS, pagerdutyServiceId: "support" }, { expectStatus: 400 })], runs([], 0)),
];

async function seed(legs, log) {
  const trail = [];
  const call = async (method, path, body) => {
    const res = await fetch(`${legs.zendesk.base_url}${path}`, { method, headers: { authorization: `Bearer ${legs.zendesk.api_key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) trail.push(`${method} ${path} ${res.status} ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { return null; }
  };
  let made = 0;
  for (const [c, rows] of Object.entries(FIXTURES)) {
    for (const [i, row] of rows.entries()) {
      const t = await call("POST", "/api/v2/tickets.json", { ticket: { subject: `SLA ${c} ${i}`, priority: row.priority, status: row.status ?? "open", tags: [scope(c), ...(row.enterprise ? ["tier_enterprise"] : [])], comment: { body: "Customer question" }, requester: { email: `${c.replaceAll("_", "-")}-${i}@sla.example`, name: "Customer" } } });
      const id = t?.ticket?.id;
      if (!id) continue;
      made++;
      if (row.reply) await call("PUT", `/api/v2/tickets/${id}.json`, { ticket: { comment: { body: "Agent reply", public: true } } });
    }
  }
  log("seed", made, "tickets;", trail.slice(0, 6).join("; "));
  return { made, trail };
}

export default {
  workflow: "support-sla-breach",
  providers: ["zendesk", "slack", "pagerduty"],
  seed,
  context: {
    goal: "Prove the support-sla-breach AgentCore runtime: a 15-minute sweep of open Zendesk tickets in a scope tag (cursor pagination) → tickets without an agent's public reply get durable timers from tier × priority targets → at 75% the assignee is warned (internal note, Slack), at 100% the ticket is tagged breached and leads told, and an enterprise breach pages PagerDuty on-call de-duplicated by incident key; each step claims the ticket with a safe_update tag so overlapping sweeps fire it once.",
    workflow: "POST /invocations {action:start} sweeps and schedules timers; {action:tick} fires due ones. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline", "baseline_effects"],
    identity_and_access: ["answered_ticket_not_timed"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: ["unanswered_ticket_timed", "enterprise_tier_detected"],
    duplicate_replay: "Overlapping sweeps claim each step with a compare-and-swap tag (local tests).",
    concurrency: "safe_update conflicts are retried; the losing sweep skips (local tests).",
    ordering_and_stale_events: ["pending_ticket_paused"],
    delayed_or_missing_events: ["breach_fires_at_target", "enterprise_breach_pages"],
    provider_auth_and_scopes: ["zendesk_rate_limited"],
    rate_limit_server_error_timeout: ["zendesk_rate_limited"],
    accepted_effect_response_loss: "Pages are de-duplicated by incident key.",
    partial_effects_and_recovery: "The claim owner's retry proceeds; others skip (local tests).",
    restart_and_durability: "SLA timers survive restarts (Kit v2 tests).",
    reconciliation: "Each timer re-reads the ticket before acting.",
    cancellation_refund_entitlements: "No customer-facing change; internal notes only.",
    data_and_privacy_boundaries: "Slack posts carry ticket ids, never ticket content.",
    cleanup_and_isolation: ["baseline"],
  },
  evidence: ["acme-ops/src/workflows/support-sla-breach.ts", "acme-ops/test/support-sla-breach.test.ts"],
};
