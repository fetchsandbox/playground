// Helpers for authoring FetchSandbox application_workflow_v1 contracts
// against an AgentCore runtime: every action is the runtime's real
// POST /invocations, every observation is the protected read-only view of the
// run state the runtime saved (GET /verify/runs/{run}/cases/{case}/runs).

export const DIMENSIONS = [
  "baseline",
  "identity_and_access",
  "schema_and_value_boundaries",
  "amount_currency_quantity",
  "duplicate_replay",
  "concurrency",
  "ordering_and_stale_events",
  "delayed_or_missing_events",
  "provider_auth_and_scopes",
  "rate_limit_server_error_timeout",
  "accepted_effect_response_loss",
  "partial_effects_and_recovery",
  "restart_and_durability",
  "reconciliation",
  "cancellation_refund_entitlements",
  "data_and_privacy_boundaries",
  "cleanup_and_isolation",
];

export const runsPath = (caseId) => `/verify/runs/{{run_id}}/cases/${caseId}/runs`;

const labels = (caseId) => ({ fs_run: "{{run_id}}", fs_case: caseId });

/**
 * POST /invocations start, scoped to this verification run and case. The
 * runId (the trigger's idempotency key) is deterministic per check, so the
 * verifier's repeated drive of a check is a re-delivery of the same trigger.
 */
export function start(caseId, input, { runId = `${caseId.replaceAll("_", "-")}-{{run_id}}`, expectStatus = 200, concurrency } = {}) {
  return {
    method: "POST",
    path: "/invocations",
    body: { action: "start", runId, input, requestedBy: { userId: "U_FETCHSANDBOX" }, labels: labels(caseId) },
    expect_status: expectStatus,
    ...(concurrency ? { concurrency } : {}),
  };
}

/** The same start action, run and labelled as another case (its own run id and observation collection). */
export function asCase(caseId, a) {
  return { ...a, body: { ...a.body, runId: `${caseId.replaceAll("_", "-")}-{{run_id}}`, labels: labels(caseId) } };
}

/** Any other command against the run created by step `step` (1-based). */
export function command(action, step, extra = {}, expectStatus = 200) {
  return { method: "POST", path: "/invocations", body: { action, runId: `{{step${step}.runId}}`, ...extra }, expect_status: expectStatus };
}

/** Ask the verifier for a real process restart of the runtime (same durable state, same bindings). */
export const restart = { client_lifecycle: { operation: "restart", observe_path: "/verify/runtime", identity_field: "instance_id", timeout_seconds: 120 } };

export const eq = (select, equals) => ({ select, equals, required: true });

/** The case's runs collection holds `count` runs matching `where`. */
export function runs(where, count = 1) {
  return { select: "runs[*]", count, required: true, ...(where.length ? { where } : {}) };
}

/** Nested: exactly `count` actions with this id (and extra conditions) inside the run. */
export function action(id, status, count = 1, extra = []) {
  return { select: "actions[*]", count, required: true, where: [eq("id", id), ...(status ? [eq("status", status)] : []), ...extra] };
}

/** Like action() but matched on kind (ids of per-account actions carry a hash suffix). */
export function actionKind(kind, status, count = 1, extra = []) {
  return { select: "actions[*]", count, required: true, where: [eq("kind", kind), ...(status ? [eq("status", status)] : []), ...extra] };
}

/** Re-send the same start as step `step` (same runId) — a duplicate trigger delivery. */
export function startAgain(caseId, input, step = 1, concurrency) {
  const a = start(caseId, input, { concurrency });
  return { ...a, body: { ...a.body, runId: `{{step${step}.runId}}` } };
}

/**
 * Conjunction. Conditions on the single run of a case are merged into ONE
 * runs[*] leaf, so they must all hold on the same run (and the verifier sees
 * the same collection as the empty `before`). Anything else becomes all_of.
 */
export function all(...assertions) {
  const single = assertions.every((a) => a.select === "runs[*]" && a.count === 1);
  if (single) return runs(assertions.flatMap((a) => a.where ?? []));
  return { all_of: assertions };
}

export function agent(name, status) {
  return { select: "agents[*]", count: 1, required: true, where: [eq("name", name), eq("status", status)] };
}

export function noAction(id) {
  return { select: "actions[*]", count: 0, required: true, where: [eq("id", id)] };
}

/** Standard executable check: empty case collection before, actions, observe the same collection. */
export function check(id, name, actions, assertion, extra = {}) {
  return {
    id,
    name,
    ...extra,
    before: { path: runsPath(id), assertion: { select: "runs[*]", count: 0, required: true } },
    actions,
    observe: { path: runsPath(id) },
    // Leaf assertions are observed twice (the saved state must be stable); all_of takes no leaf options.
    assertion: assertion.all_of ? assertion : { ...assertion, repeat: 2, stable_under_repeat: true },
  };
}

export function blocked(id, name, category, reason, evidence) {
  return { id, name, blocker: { category, reason, evidence } };
}

/** coverage_review rows: `map` is {dimension: [checkIds]} or {dimension: "reason it doesn't apply"}. */
export function coverage(map, checks) {
  const ids = new Set(checks.map((c) => c.id));
  return DIMENSIONS.map((dimension) => {
    const v = map[dimension];
    if (Array.isArray(v) && v.length) {
      const missing = v.filter((x) => !ids.has(x));
      if (missing.length) throw new Error(`coverage ${dimension} names unknown checks: ${missing}`);
      return { dimension, relevance: "relevant", reason: `Covered by ${v.join(", ")}.`, rule_ids: v };
    }
    return { dimension, relevance: "not_applicable", reason: typeof v === "string" ? v : "Not part of this workflow's promised behavior.", rule_ids: [] };
  });
}

export function scope(checks, evidence) {
  return checks.map((c) => ({
    check_id: c.id,
    classification: "in_scope",
    reason: `${c.name} is promised behavior of this AgentCore runtime.`,
    evidence,
  }));
}
