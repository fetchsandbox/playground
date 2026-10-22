import { action, actionKind, agent, all, check, command, eq, runs, start } from "./lib.mjs";

// Executable expectations for offboarding with a legal final-pay deadline
// (Kit v2: durable timers, signals, saga compensation, audit). seed() creates
// each check's WorkOS user and membership. Payroll (Gusto) and return labels
// (EasyPost) have no FetchSandbox twin, and the last-day and deadline timers
// need the verifier to move the runtime's clock: the receipt shows which of
// these promises can be measured today.
const HR = "C0PEOPLE001";
const CASES = ["baseline", "termination_filed", "payroll_approval_pays", "deadline_pays_without_approval", "rescission_undoes_termination", "access_removed_after_last_day", "late_entry_escalated", "workos_unreadable_reported", "slack_rate_limited"];
const mem = (c) => `MEM_${c}`;
const input = (c, over = {}) => ({
  terminationId: `TERM-${c.replaceAll("_", "-")}`.slice(0, 45),
  employee: { gustoId: `emp_${c}`.slice(0, 60), email: `${c.replaceAll("_", "-")}@acme.example`, personalEmail: "home@example.com", workState: "CA", homeAddress: { street1: "1 Elm St", city: "Oakland", state: "CA", zip: "94607", country: "US" } },
  type: "involuntary",
  lastDay: "2026-11-06",
  nextRegularPayday: "2026-11-13",
  equipment: [{ asset: "Laptop", weightOz: 80 }],
  hr: ["U_HR", "U_HRBP"],
  hrChannel: HR,
  approvers: ["U_PAYROLL"],
  ...over,
});
const offboard = (c, over) => start(c, input(c, over));
const tick = { method: "POST", path: "/invocations", body: { action: "tick" }, expect_status: 200 };
const ids = (c) => { const t = input(c).terminationId; return { terminate: `gusto.terminate:${t}`, rescind: `hr.rescind:${t}`, pay: `gusto.final_payroll:${t}`, verify: `access.verify_removed:${t}` }; };
const membershipOnTwin = (c, count) => ({ provider: "workos", collection: "organization_memberships", assertion: { select: "records[*]", count, required: true, where: [eq("id", mem(c))] } });
const twin = (chk, ...a) => ({ ...chk, provider_assertions: a });

export const checks = [
  check("baseline", "A termination is recorded: final-pay deadline computed from the work state (California dismissal: the last day) and posted to HR", [offboard("baseline")], runs([eq("output.finalPayDue", "2026-11-06T23:59:00.000Z"), action("slack.post_offboarding", "applied")])),
  check("termination_filed", "The termination is filed in payroll at once", [offboard("termination_filed")], runs([agent("payroll-record", "ok"), action(ids("termination_filed").terminate, "applied")])),
  check("payroll_approval_pays", "A payroll manager's approval runs the final off-cycle payroll", [offboard("payroll_approval_pays"), command("signal", 1, { actionId: ids("payroll_approval_pays").pay, value: "approve", userId: "U_PAYROLL" })], runs([action(ids("payroll_approval_pays").pay, "applied")])),
  check("deadline_pays_without_approval", "Without approval the final payroll runs four hours before the legal deadline (needs clock control)", [offboard("deadline_pays_without_approval"), tick], runs([action(ids("deadline_pays_without_approval").pay, "applied")])),
  check("rescission_undoes_termination", "An HR rescission before the last day compensates the filed termination and skips everything else", [offboard("rescission_undoes_termination"), command("signal", 1, { actionId: ids("rescission_undoes_termination").rescind, value: "approve", userId: "U_HRBP" })], runs([eq("outcome", "compensated"), action(ids("rescission_undoes_termination").terminate, "compensated")])),
  twin(check("access_removed_after_last_day", "At the end of the last day the WorkOS membership is removed and verified (needs clock control)", [offboard("access_removed_after_last_day"), tick], runs([action(`workos.remove:${mem("access_removed_after_last_day")}`, "applied"), action(ids("access_removed_after_last_day").verify, "applied")])), membershipOnTwin("access_removed_after_last_day", 0)),
  check("late_entry_escalated", "A dismissal entered after its final-pay deadline is flagged late", [offboard("late_entry_escalated", { lastDay: "2026-01-09", nextRegularPayday: "2026-01-16" })], runs([eq("output.late", true), action("slack.post_offboarding", "applied")])),
  check("workos_unreadable_reported", "When the access inventory fails, HR is told to remove access by hand", [offboard("workos_unreadable_reported")], all(runs([agent("access-inventory", "failed"), action("slack.post_offboarding", "applied")])), { fault: { provider: "workos", scenario: "auth_failure", evidence: "refusal" } }),
  check("slack_rate_limited", "Slack rate limiting loses the HR post only", [offboard("slack_rate_limited")], all(runs([action("slack.post_offboarding", "failed"), actionKind("hr.rescind", "awaiting_signal")])), { fault: { provider: "slack", scenario: "rate_limited", evidence: "refusal" } }),
  check("invalid_input_rejected", "A malformed termination id is rejected before any agent runs", [start("invalid_input_rejected", { ...input("baseline"), terminationId: "fired-ana" }, { expectStatus: 400 })], runs([], 0)),
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
    const o = await call("/organizations", { name: `Offboarding ${c}` });
    const u = await call("/user_management/users", { email: input(c).employee.email, first_name: "Ana" });
    ids[c] = (await call("/user_management/organization_memberships", { user_id: u.id, organization_id: o.id, role_slug: "admin" })).id;
  }
  for (const chk of checks) {
    const real = ids[chk.id];
    if (!real) continue;
    const fix = (where) => where?.forEach((w) => { if (typeof w.equals === "string") w.equals = w.equals.replaceAll(mem(chk.id), real); fix(w.where); });
    const walk = (x) => { if (!x) return; fix(x.where); x.all_of?.forEach(walk); };
    walk(chk.assertion);
    for (const pa of chk.provider_assertions ?? []) fix(pa.assertion.where);
  }
  log("seed", Object.keys(ids).length, "WorkOS users with a membership");
  return ids;
}

export default {
  workflow: "employee-offboarding",
  providers: ["workos", "github", "gmail", "slack", "asana"],
  seed,
  context: {
    goal: "Prove the employee-offboarding AgentCore runtime: a termination → payroll record (Gusto) and access inventory (WorkOS, GitHub) → termination filed at once; HR rescission window to the end of the last day (a rescission compensates the filed termination); final off-cycle payroll on approval or automatically four hours before the work state's legal deadline; access removed at the end of the last day and verified; equipment return labels; benefits notice draft; every step hash-chained.",
    workflow: "POST /invocations {action:start}; {action:signal} for the payroll approval or an HR rescission; {action:tick} fires the last-day and deadline timers; {action:evidence} returns the verified trail. GET /verify/runs/{run}/cases/{case}/runs reads saved run state; memberships are also asserted on the WorkOS twin.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: "Only HR may rescind and only payroll managers approve (Kit v2 signal rules).",
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: "Final wages are computed by payroll; the runtime decides when, not how much.",
    duplicate_replay: "One termination and one final payroll per termination id, even on re-runs (local tests).",
    concurrency: "Signals are compare-and-swap on the run.",
    ordering_and_stale_events: ["late_entry_escalated", "rescission_undoes_termination"],
    delayed_or_missing_events: ["deadline_pays_without_approval", "access_removed_after_last_day"],
    provider_auth_and_scopes: ["workos_unreadable_reported"],
    rate_limit_server_error_timeout: ["slack_rate_limited"],
    accepted_effect_response_loss: "Termination and payroll creation look for an existing record first (local tests).",
    partial_effects_and_recovery: ["rescission_undoes_termination"],
    restart_and_durability: "Timers and signals survive restarts (Kit v2 tests).",
    reconciliation: "Access removal is re-read from every system before the record closes.",
    cancellation_refund_entitlements: ["termination_filed", "payroll_approval_pays"],
    data_and_privacy_boundaries: "Slack and the record carry a hash of the employee's email, the state and dates; the home address goes only to the carrier.",
    cleanup_and_isolation: ["baseline"],
  },
  evidence: ["acme-ops/src/workflows/employee-offboarding.ts", "acme-ops/test/employee-offboarding.test.ts", "acme-ops/test/kit-v2.test.ts"],
};
