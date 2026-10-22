import { action, actionKind, agent, all, blocked, check, command, eq, restart, runs, start, startAgain } from "./lib.mjs";

// seed() builds every check's own identity world on the session's WorkOS twin:
// organizations (org_seed_<check>_<x>), the suspected user, a co-admin where
// the fixture has one, and memberships (om_seed_<check>_<x>), plus the user's
// Stripe customer. Placeholders in inputs, action ids and provider assertions
// are replaced with the real ids. The user's remaining memberships are also
// asserted on the WorkOS twin, independently of the app's record.
const CHANNEL = "C0SECURITY1";
const APPROVER = "U_CISO";
const HIGH = ["mfa_reset", "admin_role_granted"];
const MEDIUM = ["mfa_reset", "new_device"];

/**
 * Per check: the suspected user's memberships as [org, role, hasCoAdmin], and
 * Stripe extras. Org "a" always has a co-admin; "b" makes the user its only admin.
 */
const SHARED = ["a", "admin", true];
const SOLE = ["b", "admin", false];
const MEMBER = ["c", "member", false];
const FIXTURES = {
  baseline: { memberships: [SHARED, MEMBER] },
  last_admin_parked: { memberships: [SHARED, SOLE] },
  last_admin_approved: { memberships: [SHARED, SOLE] },
  last_admin_rejected: { memberships: [SHARED, SOLE] },
  approve_by_stranger_refused: { memberships: [SOLE] },
  medium_risk_asks_first: { memberships: [SHARED] },
  low_risk_monitors: { memberships: [SHARED] },
  refund_spike_escalates: { memberships: [SHARED], refund: 60_000 },
  rerun_finds_contained: { memberships: [SHARED, MEMBER] },
  duplicate_start: { memberships: [SHARED] },
  concurrent_start: { memberships: [SHARED] },
  unknown_account_nothing: { memberships: [], noUser: true, noCustomer: true },
  restore_with_approval: { memberships: [SHARED, MEMBER] },
  restore_leaves_other_hold: { memberships: [MEMBER], hold: "SEC-OTHER-0001" },
  workos_auth_failure: { memberships: [SHARED] },
  stripe_rate_limited: { memberships: [SHARED] },
  slack_rate_limited: { memberships: [SHARED] },
  restart_while_parked: { memberships: [SOLE] },
  reconcile_reads_back: { memberships: [SHARED] },
};

const email = (caseId) => `${caseId.replaceAll("_", "-")}@victim.example.com`;
const org = (caseId, x) => `org_seed_${caseId}_${x}`;
const om = (caseId, x) => `om_seed_${caseId}_${x}`;
const user = (caseId) => `user_seed_${caseId}`;
const alertId = (caseId) => `SEC-${caseId.replaceAll("_", "-")}`.slice(0, 64);
const alert = (caseId, signals = HIGH, over = {}) => ({ stage: "contain", alertId: alertId(caseId), email: email(caseId), signals, source: "idp-risk", securityChannel: CHANNEL, approvers: [APPROVER], ...over });
const contain = (caseId, signals, opts) => start(caseId, alert(caseId, signals), opts);
const restoreInput = (caseId, memberships) => ({ stage: "restore", alertId: alertId(caseId), email: email(caseId), memberships: memberships.map(([x, role]) => ({ organizationId: org(caseId, x), role })), securityChannel: CHANNEL, approvers: [APPROVER] });
const removal = (caseId, x, status, extra = []) => action(`workos.remove_membership:${om(caseId, x)}`, status, 1, extra);
const removals = (status, count) => actionKind("workos.remove_membership", status, count);
const hold = (status, count = 1) => actionKind("stripe.hold_customer", status, count);
/** Whether the user's seeded membership in org x still exists on the WorkOS twin (twin sample records carry no user_id, so match by id). */
const onTwin = (caseId, x, count) => ({ provider: "workos", collection: "organization_memberships", assertion: { select: "records[*]", count, required: true, where: [eq("id", om(caseId, x))] } });
const kept = (caseId, x) => onTwin(caseId, x, 1);
const gone = (caseId, x) => onTwin(caseId, x, 0);
/** All of the user's memberships on the twin, including restored ones (new ids). */
const userMemberships = (caseId, count) => ({ provider: "workos", collection: "organization_memberships", assertion: { select: "records[*]", count, required: true, where: [{ select: "user_id", equals: user(caseId), required: false }] } });
const twin = (c, ...assertions) => ({ ...c, provider_assertions: assertions });
const faulted = (id, name, provider, scenario, assertions, signals = HIGH) => check(id, name, [contain(id, signals)], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });

export const checks = [
  twin(
    check("baseline", "A high-risk takeover holds the account's refunds and removes its admin seat in an organization that keeps another admin; the record and alert go out", [contain("baseline")], runs([eq("phase", "DONE"), eq("outcome", "ok"), eq("output.level", "high"), hold("applied"), removal("baseline", "a", "applied", [eq("attempts", 1)]), removals(null, 1), action("asana.incident_record", "applied"), action("slack.post_alert", "applied")])),
    gone("baseline", "a"), kept("baseline", "c"),
  ),
  twin(
    check("last_admin_parked", "The user's seat as an organization's only admin is not removed automatically: it waits for approval while the shared one goes", [contain("last_admin_parked")], runs([eq("phase", "AWAITING_APPROVAL"), removal("last_admin_parked", "a", "applied"), removal("last_admin_parked", "b", "pending_approval")])),
    gone("last_admin_parked", "a"), kept("last_admin_parked", "b"),
  ),
  twin(check("last_admin_approved", "Security's approval removes the sole-admin seat once", [contain("last_admin_approved"), command("decide", 1, { decision: "approve", userId: APPROVER })], runs([eq("phase", "DONE"), removal("last_admin_approved", "b", "applied", [eq("attempts", 1)])])), gone("last_admin_approved", "b")),
  twin(check("last_admin_rejected", "A rejected removal leaves the organization its admin", [contain("last_admin_rejected"), command("decide", 1, { decision: "reject", userId: APPROVER })], runs([eq("phase", "REJECTED"), removal("last_admin_rejected", "b", "rejected")])), kept("last_admin_rejected", "b")),
  check("approve_by_stranger_refused", "Someone who is not a security approver cannot release a removal", [contain("approve_by_stranger_refused"), command("decide", 1, { decision: "approve", userId: "U_HELPDESK" }, 403)], runs([eq("phase", "AWAITING_APPROVAL"), removal("approve_by_stranger_refused", "b", "pending_approval")])),
  twin(check("medium_risk_asks_first", "At medium risk refunds are held at once but no membership is removed without approval", [contain("medium_risk_asks_first", MEDIUM)], runs([eq("phase", "AWAITING_APPROVAL"), eq("output.level", "medium"), hold("applied"), removal("medium_risk_asks_first", "a", "pending_approval")])), kept("medium_risk_asks_first", "a")),
  twin(check("low_risk_monitors", "A low-risk alert changes nothing and is posted for monitoring", [contain("low_risk_monitors", ["new_device"])], runs([eq("phase", "DONE"), eq("output.mode", "monitor"), hold(null, 0), removals(null, 0), action("slack.post_alert", "applied")])), kept("low_risk_monitors", "a")),
  twin(check("refund_spike_escalates", "A refund spike on the account's own Stripe customer raises a medium alert to high and contains it", [contain("refund_spike_escalates", MEDIUM)], runs([eq("output.level", "high"), removal("refund_spike_escalates", "a", "applied")])), gone("refund_spike_escalates", "a")),
  twin(
    check("rerun_finds_contained", "A repeated alert (a new trigger) finds the account contained and changes nothing", [contain("rerun_finds_contained"), contain("rerun_finds_contained", HIGH, { runId: "rerun-b-{{run_id}}" })], all(runs([], 2), runs([removal("rerun_finds_contained", "a", "applied")]), runs([eq("output.mode", "nothing"), removals(null, 0), hold(null, 0)]))),
    gone("rerun_finds_contained", "a"), kept("rerun_finds_contained", "c"),
  ),
  twin(check("duplicate_start", "A re-delivered alert contains once", [contain("duplicate_start"), startAgain("duplicate_start", alert("duplicate_start"))], runs([removal("duplicate_start", "a", "applied", [eq("attempts", 1)]), hold("applied")])), gone("duplicate_start", "a")),
  twin(check("concurrent_start", "Four simultaneous deliveries of one alert contain once", [contain("concurrent_start"), startAgain("concurrent_start", alert("concurrent_start"), 1, 4)], runs([removal("concurrent_start", "a", "applied", [eq("attempts", 1)]), hold("applied", 1)])), gone("concurrent_start", "a")),
  check("unknown_account_nothing", "An alert for an address with no user and no billing account changes nothing", [contain("unknown_account_nothing")], runs([eq("phase", "DONE"), eq("output.mode", "nothing"), hold(null, 0), removals(null, 0)])),
  twin(
    check(
      "restore_with_approval",
      "After the investigation, restore waits for approval and then puts the removed admin seat back",
      [contain("restore_with_approval"), start("restore_with_approval", restoreInput("restore_with_approval", [SHARED, MEMBER]), { runId: "restore-{{run_id}}" }), command("decide", 2, { decision: "approve", userId: APPROVER })],
      all(runs([], 2), runs([eq("output.mode", "restore"), eq("output.restores", 1), eq("output.releases", 1), action(`workos.restore_membership:${org("restore_with_approval", "a")}`, "applied"), actionKind("stripe.release_hold", "applied", 1)])),
    ),
    gone("restore_with_approval", "a"), kept("restore_with_approval", "c"), userMemberships("restore_with_approval", 2),
  ),
  check("restore_leaves_other_hold", "Restore releases only its own alert's hold, never another investigation's", [start("restore_leaves_other_hold", restoreInput("restore_leaves_other_hold", []))], runs([eq("output.mode", "restore"), eq("output.releases", 0), actionKind("stripe.release_hold", null, 0)])),
  twin(faulted("workos_auth_failure", "Without the directory nothing is held or removed blindly; Slack escalates", "workos", "auth_failure", [agent("identity", "failed"), eq("output.mode", "blocked"), hold(null, 0), removals(null, 0), action("slack.post_alert", "applied")]), kept("workos_auth_failure", "a")),
  twin(faulted("stripe_rate_limited", "When billing can't be read, containment still removes the admin seat but holds nothing", "stripe", "rate_limited", [agent("billing", "failed"), removal("stripe_rate_limited", "a", "applied"), hold(null, 0)]), gone("stripe_rate_limited", "a")),
  faulted("slack_rate_limited", "Slack rate limiting fails the post only; containment happens", "slack", "rate_limited", [action("slack.post_alert", "failed"), removal("slack_rate_limited", "a", "applied"), hold("applied")]),
  check("restart_while_parked", "A removal parked for approval survives a real runtime restart and is applied once when approved", [contain("restart_while_parked"), restart, command("decide", 1, { decision: "approve", userId: APPROVER })], runs([eq("phase", "DONE"), removal("restart_while_parked", "b", "applied", [eq("attempts", 1)])])),
  check("reconcile_reads_back", "Reconcile finds the membership still removed and the hold still on the customer", [contain("reconcile_reads_back"), command("reconcile", 1)], runs([removal("reconcile_reads_back", "a", "applied", [eq("reconcile.status", "match")]), hold("applied", 1, [eq("reconcile.status", "match")])])),
  check("invalid_input_rejected", "An alert with an unknown signal is rejected before any agent runs", [start("invalid_input_rejected", { ...alert("baseline"), signals: ["looks_bad"] }, { expectStatus: 400 })], runs([], 0)),
  blocked("sessions_revoked", "Every live session of the user is revoked, including ones opened since the scan", "observation_missing", "The WorkOS twin's GET /user_management/users/{id}/sessions returns sample sessions under `items` (not the API's `data`), and POST /user_management/sessions/revoke echoes any id, so revocation can't be observed. The runtime lists and revokes real sessions; covered by local tests.", ["acme-ops/src/workflows/account-takeover-containment.ts workos.revoke_sessions", "GET /user_management/users/{id}/sessions on the twin → {items:[Sample Session 1, ...]}"]),
  blocked("co_admin_left_before_removal", "An automatic removal is refused when the organization's other admin left between the scan and the write", "setup_missing", "The verifier can't place a provider write between the runtime's directory read and its removal inside one run. The write-time re-check is covered by a deterministic local test.", ["acme-ops/test/account-takeover-containment.test.ts \"refuses to auto-remove an admin whose co-admin left since the scan\""]),
];

/** Organizations, users, memberships and Stripe customers per check, on the session's twins. */
async function seed(legs, log) {
  const workos = async (path, json) => {
    const res = await fetch(`${legs.workos.base_url}${path}`, { method: "POST", headers: { authorization: `Bearer ${legs.workos.api_key}`, "content-type": "application/json" }, body: JSON.stringify(json) });
    const body = await res.json();
    if (!res.ok || !body.id) throw new Error(`seed ${path} → ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
    return body;
  };
  const stripe = async (path, form) => {
    const res = await fetch(`${legs.stripe.base_url}${path}`, { method: "POST", headers: { authorization: `Bearer ${legs.stripe.api_key}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
    const body = await res.json();
    if (!res.ok || !body.id) throw new Error(`seed ${path} → ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
    return body;
  };
  const ids = {};
  for (const [caseId, f] of Object.entries(FIXTURES)) {
    const map = (ids[caseId] = {});
    if (!f.noUser) {
      const u = await workos("/user_management/users", { email: email(caseId), first_name: "Robin" });
      map[user(caseId)] = u.id;
      for (const [x, role, coAdmin] of f.memberships) {
        const o = await workos("/organizations", { name: `ATO ${caseId} ${x}` });
        map[org(caseId, x)] = o.id;
        map[om(caseId, x)] = (await workos("/user_management/organization_memberships", { user_id: u.id, organization_id: o.id, role_slug: role })).id;
        if (coAdmin) {
          const other = await workos("/user_management/users", { email: `co-admin-${x}-${caseId.replaceAll("_", "-")}@victim.example.com`, first_name: "Sam" });
          await workos("/user_management/organization_memberships", { user_id: other.id, organization_id: o.id, role_slug: "admin" });
        }
      }
    }
    if (!f.noCustomer) {
      const cus = await stripe("/v1/customers", { email: email(caseId), name: "Robin Customer", ...(f.hold ? { "metadata[acme_ato_hold]": f.hold } : {}) });
      if (f.refund) {
        const p = await stripe("/v1/payment_intents", { amount: String(f.refund), currency: "usd", customer: cus.id, confirm: "true", payment_method: "pm_card_visa" });
        await stripe("/v1/refunds", { payment_intent: p.id, amount: String(f.refund) });
      }
    }
  }
  // Point every check's inputs, action ids and provider assertions at the real ids.
  for (const c of checks) {
    const map = ids[c.id];
    if (!map) continue;
    const swap = (v) => {
      if (typeof v !== "string") return v;
      for (const [k, real] of Object.entries(map)) if (v === k || v.endsWith(`:${k}`)) return v.slice(0, v.length - k.length) + real;
      return v;
    };
    for (const a of c.actions ?? []) for (const m of a.body?.input?.memberships ?? []) m.organizationId = swap(m.organizationId);
    const fix = (where) => where?.forEach((w) => { w.equals = swap(w.equals); fix(w.where); });
    const walk = (a) => { if (!a) return; fix(a.where); a.all_of?.forEach(walk); };
    walk(c.assertion);
    for (const pa of c.provider_assertions ?? []) fix(pa.assertion.where);
  }
  log("seed", Object.keys(ids).length, "identity worlds");
  return ids;
}

export default {
  workflow: "account-takeover-containment",
  providers: ["workos", "stripe", "asana", "slack"],
  seed,
  context: {
    goal: "Prove the account-takeover-containment AgentCore runtime: a suspected takeover alert → parallel WorkOS identity read (memberships, co-admins) and Stripe billing read (refund spike, holds) → risk score in code → Stripe refund hold, removal of privileged memberships (automatic only at high risk and never an organization's last admin), Asana record with restore input, Slack alert; restore puts memberships back and releases only its own hold, always with approval.",
    workflow: "POST /invocations {action:start, input.stage:contain|restore} assesses, contains or restores and parks what needs approval; {action:decide} releases or withholds it; {action:reconcile} reads removals and holds back. GET /verify/runs/{run}/cases/{case}/runs reads saved run state; the user's memberships are also asserted on the WorkOS twin.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["last_admin_parked", "approve_by_stranger_refused", "unknown_account_nothing"],
    schema_and_value_boundaries: ["invalid_input_rejected", "low_risk_monitors"],
    amount_currency_quantity: ["refund_spike_escalates"],
    duplicate_replay: ["duplicate_start", "rerun_finds_contained"],
    concurrency: ["concurrent_start", "co_admin_left_before_removal"],
    ordering_and_stale_events: ["restore_leaves_other_hold", "co_admin_left_before_removal"],
    delayed_or_missing_events: "Alerts are direct calls from the SIEM; no provider events are consumed.",
    provider_auth_and_scopes: ["workos_auth_failure"],
    rate_limit_server_error_timeout: ["stripe_rate_limited", "slack_rate_limited"],
    accepted_effect_response_loss: "A membership removal whose response is lost is found already removed on retry (alreadyRemoved), and the hold is a metadata write that is safe to repeat (local tests).",
    partial_effects_and_recovery: ["stripe_rate_limited", "slack_rate_limited", "restore_with_approval"],
    restart_and_durability: ["restart_while_parked"],
    reconciliation: ["reconcile_reads_back"],
    cancellation_refund_entitlements: ["last_admin_approved", "last_admin_rejected", "medium_risk_asks_first", "sessions_revoked"],
    data_and_privacy_boundaries: "The record and alerts carry a hash of the user's address, organization and membership ids; no alert text is echoed beyond the source label.",
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: ["acme-ops/src/workflows/account-takeover-containment.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/providers/{work,stripe,slack}.ts"],
};
