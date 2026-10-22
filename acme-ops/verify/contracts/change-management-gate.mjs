import { action, actionKind, agent, all, check, command, eq, runs, start } from "./lib.mjs";

// Executable expectations for a production change gate (Kit v2: signals,
// delayAfter watch window, saga rollback). GitHub, PagerDuty, Datadog and
// Slack all have FetchSandbox twins; seed() tries to create what each check
// needs through the twins' own APIs (a merged PR with an approving review and
// a green check run, a previous deployment, a monitor) and records anything a
// twin refuses, instead of failing. The watch window needs the verifier to
// move the runtime's clock.
const OPS = "C0PLATFORM1";
const REPO = "acme/checkout";
const input = (c, over = {}) => ({
  changeId: `CHG-${c.replaceAll("_", "-")}`.slice(0, 44),
  repo: REPO,
  pullRequest: 1,
  service: { name: "checkout", pagerdutyServiceId: "PSVC123", monitorIds: [], errorRateQuery: "sum:checkout.errors{*}.as_rate()" },
  type: "standard",
  opsChannel: OPS,
  approvers: ["U_CAB_1", "U_CAB_2"],
  ...over,
});
const gate = (c, over) => start(c, input(c, over));
const tick = { method: "POST", path: "/invocations", body: { action: "tick" }, expect_status: 200 };
const ids = (c) => { const k = input(c).changeId; return { cab: `cab.approve:${k}`, deploy: `github.deploy:${k}`, watch: `datadog.watch:${k}`, done: `github.mark_success:${k}` }; };

export const checks = [
  check("baseline", "A change request is checked and its outcome posted to operations", [gate("baseline")], runs([actionKind("slack.post_change", "applied")])),
  check("change_facts_read", "The pull request, its reviews and check runs are read from GitHub", [gate("change_facts_read")], runs([agent("change-check", "ok")])),
  check("ops_facts_read", "Open incidents (PagerDuty) and monitor states (Datadog) are read", [gate("ops_facts_read")], runs([agent("ops-check", "ok")])),
  check("standard_change_deploys", "A merged, reviewed, green standard change with no incident deploys automatically", [gate("standard_change_deploys")], runs([eq("output.mode", "deploy"), action(ids("standard_change_deploys").deploy, "applied")])),
  check("normal_change_needs_cab", "A normal change waits for a CAB approver", [gate("normal_change_needs_cab", { type: "normal" })], runs([eq("output.mode", "needs_cab"), action(ids("normal_change_needs_cab").cab, "awaiting_signal")])),
  check("author_cannot_approve", "The change's author can't approve it", [gate("author_cannot_approve", { type: "normal", approvers: ["U_CAB_1", "octocat"] }), command("signal", 1, { actionId: ids("author_cannot_approve").cab, value: "approve", userId: "octocat" }, 403)], runs([action(ids("author_cannot_approve").cab, "awaiting_signal")])),
  check("healthy_watch_marks_success", "After a healthy 15-minute watch the deployment is marked successful (needs clock control)", [gate("healthy_watch_marks_success"), tick], runs([action(ids("healthy_watch_marks_success").done, "applied")])),
  check("degraded_watch_rolls_back", "A degraded watch window rolls the deployment back (needs clock control and a scriptable error rate)", [gate("degraded_watch_rolls_back"), tick], runs([eq("outcome", "compensated"), action(ids("degraded_watch_rolls_back").deploy, "compensated")])),
  check("freeze_blocks", "A change inside a freeze window is blocked", [gate("freeze_blocks", { freezes: [{ from: "2020-01-01T00:00:00.000Z", to: "2099-01-01T00:00:00.000Z", reason: "test freeze" }] })], runs([eq("output.mode", "blocked"), actionKind("github.deploy", null, 0)])),
  check("github_unreadable_blocks", "When the pull request can't be read nothing deploys", [gate("github_unreadable_blocks")], all(runs([agent("change-check", "failed"), eq("output.mode", "blocked"), actionKind("github.deploy", null, 0)])), { fault: { provider: "github", scenario: "auth_failure", evidence: "refusal" } }),
  check("invalid_input_rejected", "A malformed repository is rejected before any agent runs", [start("invalid_input_rejected", { ...input("baseline"), repo: "not a repo" }, { expectStatus: 400 })], runs([], 0)),
];

async function seed(legs, log) {
  const trail = [];
  const call = async (leg, method, path, json) => {
    const res = await fetch(`${legs[leg].base_url}${path}`, { method, headers: { authorization: `Bearer ${legs[leg].api_key}`, "content-type": "application/json" }, body: json ? JSON.stringify(json) : undefined });
    let body;
    try { body = await res.json(); } catch { body = {}; }
    trail.push(`${leg} ${method} ${path} → ${res.status}`);
    return { status: res.status, body };
  };
  // Use the pull request the twin actually created, and the monitor id it returned.
  const created = await call("github", "POST", `/repos/${REPO}/pulls`, { title: "Fix checkout rounding", head: "fix-rounding", base: "main" });
  const n = created.body?.number;
  trail.push(`pull created: number=${n ?? "none"} (keys ${Object.keys(created.body ?? {}).slice(0, 8).join(",")})`);
  if (n) {
    await call("github", "PUT", `/repos/${REPO}/pulls/${n}/merge`, {});
    await call("github", "POST", `/repos/${REPO}/pulls/${n}/reviews`, { event: "APPROVE", body: "LGTM" });
    const pr = await call("github", "GET", `/repos/${REPO}/pulls/${n}`);
    trail.push(`pull ${n}: merged=${pr.body?.merged} user=${pr.body?.user?.login}`);
  }
  await call("github", "POST", `/repos/${REPO}/deployments`, { ref: "main", environment: "production", payload: {} });
  const mon = await call("datadog", "POST", "/api/v1/monitor", { name: "checkout 5xx", type: "metric alert", query: "avg(last_5m):sum:checkout.errors{*} > 5" });
  // Datadog documents monitor ids as integers; record anything else instead of using it.
  const monitorId = Number.isInteger(Number(mon.body?.id)) ? Number(mon.body.id) : undefined;
  if (mon.body?.id !== undefined && monitorId === undefined) trail.push(`monitor id is ${JSON.stringify(mon.body.id)}, not an integer`);
  for (const [i, c] of checks.entries()) {
    let json = JSON.stringify(c);
    if (n) json = json.replaceAll('"pullRequest":1', `"pullRequest":${n}`);
    if (monitorId) json = json.replaceAll('"monitorIds":[]', `"monitorIds":[${Number(monitorId)}]`);
    checks[i] = JSON.parse(json);
  }
  log("seed", trail.join("; "));
  return { trail };
}

export default {
  workflow: "change-management-gate",
  providers: ["github", "pagerduty", "datadog", "slack"],
  seed,
  context: {
    goal: "Prove the change-management-gate AgentCore runtime: a production change → parallel GitHub change facts (merged, check runs, approving reviews by someone other than the author) and operations facts (PagerDuty high-urgency incidents, Datadog monitors) → freeze calendar → deploy (standard), CAB approval by a non-author (normal), deploy-then-review (emergency) or block; a 15-minute watch after the deploy; degradation rolls back to the previous deployment (saga compensation).",
    workflow: "POST /invocations {action:start}; {action:signal} for CAB approvals; {action:tick} fires the watch; {action:evidence}. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["author_cannot_approve"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: "Error-rate threshold is code (local tests).",
    duplicate_replay: "A deployment carrying the change id is reused, not repeated (local tests).",
    concurrency: "Signals are compare-and-swap on the run.",
    ordering_and_stale_events: ["freeze_blocks"],
    delayed_or_missing_events: ["healthy_watch_marks_success", "degraded_watch_rolls_back"],
    provider_auth_and_scopes: ["github_unreadable_blocks"],
    rate_limit_server_error_timeout: ["github_unreadable_blocks"],
    accepted_effect_response_loss: "Deployments are found by change id before creating one.",
    partial_effects_and_recovery: ["degraded_watch_rolls_back"],
    restart_and_durability: "The watch timer survives restarts (Kit v2 tests).",
    reconciliation: "Deployment statuses record the outcome on GitHub.",
    cancellation_refund_entitlements: ["standard_change_deploys", "normal_change_needs_cab"],
    data_and_privacy_boundaries: "Only repository, commit and service names leave the runtime.",
    cleanup_and_isolation: ["baseline"],
  },
  evidence: ["acme-ops/src/workflows/change-management-gate.ts", "acme-ops/test/change-management-gate.test.ts"],
};
