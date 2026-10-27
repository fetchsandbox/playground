import { action, actionKind, agent, all, check, command, eq, runs, start } from "./lib.mjs";

// Executable expectations for a quarterly access review (Kit v2 signals per
// entitlement, timers for reminders and the deadline, hash-chained evidence).
// seed() creates each check's WorkOS organization with an admin and a dormant
// member and swaps ORG_<check> / MEM_<check>_<x> for the real ids. GitHub org
// membership is in scope too: whether the GitHub twin can list and remove
// organization members is part of what this contract measures.
const GRC = "C0SECURITY1";
const OWNER = { userId: "U_IT_OWNER", email: "it.owner@acme.example" };
const ENG = { userId: "U_ENG_OWNER", email: "eng.owner@acme.example" };

const CASES = ["baseline", "campaign_covers_every_system", "owner_revokes_access", "owner_keeps_access", "no_self_review", "outsider_cannot_decide", "deadline_revokes_unreviewed_admin", "reminder_only_for_open_items", "github_member_revoked", "workos_unreadable_blocks", "slack_rate_limited"];
const org = (c) => `ORG_${c}`;
const mem = (c, x) => `MEM_${c}_${x}`;
const input = (c, over = {}) => ({
  campaignId: `UAR-${c.replaceAll("_", "-")}`.slice(0, 44),
  scope: { workosOrganizations: [org(c)], ...(over.github ? { githubOrg: "acme" } : {}) },
  owners: { workos: c === "no_self_review" ? { userId: "U_IT_OWNER", email: `admin-${c.replaceAll("_", "-")}@acme.example` } : OWNER, github: ENG },
  githubEmails: {},
  grcChannel: GRC,
  approvers: ["U_CISO"],
});
const campaign = (c, over) => start(c, input(c, over));
const decide = (c, x, value, userId, status = 200) => command("signal", 1, { actionId: `revoke:workos:${mem(c, x)}`, value, userId }, status);
const membershipOnTwin = (c, x, count) => ({ provider: "workos", collection: "organization_memberships", assertion: { select: "records[*]", count, required: true, where: [eq("id", mem(c, x))] } });
const twin = (chk, ...a) => ({ ...chk, provider_assertions: a });

export const checks = [
  check("baseline", "A campaign reads the organization's memberships and opens: one decision per entitlement, posted to GRC", [campaign("baseline")], runs([eq("phase", "WAITING"), eq("output.mode", "review"), eq("output.entitlements", 2), actionKind("access.decide_and_revoke", "awaiting_signal", 2), action("slack.campaign_opened", "applied")])),
  check("campaign_covers_every_system", "With the GitHub organization in scope, its members are part of the campaign too", [campaign("campaign_covers_every_system", { github: true })], runs([agent("github-entitlements", "ok"), eq("output.mode", "review")])),
  twin(check("owner_revokes_access", "The system owner's revoke decision removes the membership", [campaign("owner_revokes_access"), decide("owner_revokes_access", "member", "approve", OWNER.userId)], runs([action(`revoke:workos:${mem("owner_revokes_access", "member")}`, "applied")])), membershipOnTwin("owner_revokes_access", "member", 0)),
  twin(check("owner_keeps_access", "A keep decision leaves the membership in place", [campaign("owner_keeps_access"), decide("owner_keeps_access", "admin", "reject", OWNER.userId)], runs([action(`revoke:workos:${mem("owner_keeps_access", "admin")}`, "rejected")])), membershipOnTwin("owner_keeps_access", "admin", 1)),
  check("no_self_review", "An owner can't certify their own admin access; the CISO decides it", [campaign("no_self_review"), decide("no_self_review", "admin", "reject", "U_IT_OWNER", 403), decide("no_self_review", "admin", "reject", "U_CISO")], runs([action(`revoke:workos:${mem("no_self_review", "admin")}`, "rejected")])),
  check("outsider_cannot_decide", "Someone who is neither the owner nor a GRC approver can't decide", [campaign("outsider_cannot_decide"), decide("outsider_cannot_decide", "member", "approve", "U_INTERN", 403)], runs([action(`revoke:workos:${mem("outsider_cannot_decide", "member")}`, "awaiting_signal")])),
  twin(check("deadline_revokes_unreviewed_admin", "At the 14-day deadline unreviewed admin access is revoked (needs the verifier to advance the runtime's clock)", [campaign("deadline_revokes_unreviewed_admin"), { method: "POST", path: "/invocations", body: { action: "tick" }, expect_status: 200 }], runs([action(`revoke:workos:${mem("deadline_revokes_unreviewed_admin", "admin")}`, "applied")])), membershipOnTwin("deadline_revokes_unreviewed_admin", "admin", 0)),
  check("reminder_only_for_open_items", "On day 7 the owner is reminded only if decisions are still open (needs clock control)", [campaign("reminder_only_for_open_items"), { method: "POST", path: "/invocations", body: { action: "tick" }, expect_status: 200 }], runs([action(`slack.remind:${OWNER.userId}:d7`, "applied")])),
  check("github_member_revoked", "A revoke decision on a GitHub member removes them from the organization", [campaign("github_member_revoked", { github: true })], runs([actionKind("access.decide_and_revoke", "awaiting_signal", 4)])),
  check("workos_unreadable_blocks", "When WorkOS can't be read, no campaign opens on partial data and GRC is told", [campaign("workos_unreadable_blocks")], all(runs([agent("workos-entitlements", "failed"), eq("output.mode", "blocked"), actionKind("access.decide_and_revoke", null, 0), action("slack.campaign_opened", "applied")])), { fault: { provider: "workos", scenario: "auth_failure", evidence: "refusal" } }),
  check("slack_rate_limited", "Slack rate limiting loses the announcement only; the campaign still opens", [campaign("slack_rate_limited")], all(runs([action("slack.campaign_opened", "failed"), actionKind("access.decide_and_revoke", "awaiting_signal", 2)])), { fault: { provider: "slack", scenario: "rate_limited", evidence: "refusal" } }),
  check("invalid_input_rejected", "A malformed campaign id is rejected before any agent runs", [start("invalid_input_rejected", { ...input("baseline"), campaignId: "Q4 review" }, { expectStatus: 400 })], runs([], 0)),
];

async function seed(legs, log) {
  const call = async (path, json) => {
    const res = await fetch(`${legs.workos.base_url}${path}`, { method: "POST", headers: { authorization: `Bearer ${legs.workos.api_key}`, "content-type": "application/json" }, body: JSON.stringify(json) });
    const body = await res.json();
    if (!res.ok || !body.id) throw new Error(`seed ${path} → ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    return body;
  };
  const ids = {};
  for (const c of CASES) {
    const tag = c.replaceAll("_", "-");
    const o = await call("/organizations", { name: `UAR ${c}` });
    const admin = await call("/user_management/users", { email: c === "no_self_review" ? `admin-${tag}@acme.example` : `ops-admin-${tag}@acme.example`, first_name: "Ops" });
    const member = await call("/user_management/users", { email: `contractor-${tag}@acme.example`, first_name: "Contractor" });
    const ma = await call("/user_management/organization_memberships", { user_id: admin.id, organization_id: o.id, role_slug: "admin" });
    const mm = await call("/user_management/organization_memberships", { user_id: member.id, organization_id: o.id, role_slug: "member" });
    ids[c] = { [org(c)]: o.id, [mem(c, "admin")]: ma.id, [mem(c, "member")]: mm.id };
  }
  for (const chk of checks) {
    const map = ids[chk.id];
    if (!map) continue;
    const swap = (v) => { if (typeof v !== "string") return v; for (const [k, real] of Object.entries(map)) v = v.replaceAll(k, real); return v; };
    for (const a of chk.actions ?? []) {
      if (a.body?.input?.scope) a.body.input.scope.workosOrganizations = a.body.input.scope.workosOrganizations.map(swap);
      if (a.body?.actionId) a.body.actionId = swap(a.body.actionId);
    }
    const fix = (where) => where?.forEach((w) => { w.equals = swap(w.equals); fix(w.where); });
    const walk = (x) => { if (!x) return; fix(x.where); x.all_of?.forEach(walk); };
    walk(chk.assertion);
    for (const pa of chk.provider_assertions ?? []) fix(pa.assertion.where);
  }
  log("seed", Object.keys(ids).length, "WorkOS organizations");
  return ids;
}

export default {
  workflow: "user-access-review",
  providers: ["workos", "github", "slack", "asana"],
  seed,
  context: {
    goal: "Prove the user-access-review AgentCore runtime: quarterly access campaign → parallel WorkOS membership and GitHub organization reads (checkpointed) → one keep/revoke signal per entitlement from its system owner (no self-review, GRC for unowned), day 7/12 reminders for open items, deadline defaults (privileged revoked, standard kept), verified revocations and a closing evidence record; every decision hash-chained.",
    workflow: "POST /invocations {action:start} opens the campaign; {action:signal, actionId:'revoke:<entitlement>', value:approve(revoke)|reject(keep), userId}; {action:tick} fires reminders and the deadline; {action:evidence} returns the verified trail. GET /verify/runs/{run}/cases/{case}/runs reads saved run state; memberships are also asserted on the WorkOS twin.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["no_self_review", "outsider_cannot_decide"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: "Campaigns over 500 entitlements are refused and must be split (local tests).",
    duplicate_replay: "A repeated decision is idempotent; a conflicting one is 409 (Kit v2 tests).",
    concurrency: "Decisions are compare-and-swap on the run (Kit v2 tests).",
    ordering_and_stale_events: "Access removed by someone else before the decision is recorded as already gone (local tests).",
    delayed_or_missing_events: ["deadline_revokes_unreviewed_admin", "reminder_only_for_open_items"],
    provider_auth_and_scopes: ["workos_unreadable_blocks"],
    rate_limit_server_error_timeout: ["slack_rate_limited"],
    accepted_effect_response_loss: "Revocations re-check the membership before deleting.",
    partial_effects_and_recovery: ["workos_unreadable_blocks"],
    restart_and_durability: "Entitlement pulls are checkpointed per organization; waiting runs survive restarts (Kit v2 tests).",
    reconciliation: "Revocations reconcile against WorkOS and GitHub (local tests).",
    cancellation_refund_entitlements: ["owner_revokes_access", "owner_keeps_access", "github_member_revoked"],
    data_and_privacy_boundaries: "Slack and the record carry hashed holder ids and counts, not emails.",
    cleanup_and_isolation: ["baseline", "campaign_covers_every_system"],
  },
  evidence: ["acme-ops/src/workflows/user-access-review.ts", "acme-ops/src/kit/engine.ts", "acme-ops/test/user-access-review.test.ts"],
};
