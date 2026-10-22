import { action, actionKind, agent, all, check, command, eq, runs, start, asCase } from "./lib.mjs";

// Executable expectations for the payroll anomaly review (Gusto payroll
// history, version-guarded exclusion, Kit v2 deadline signal that defaults to
// holding the flagged employees). Gusto has no FetchSandbox twin, so this
// receipt measures how much of a payroll control can be proven without one.
const PAYROLL = "C0PAYROLL01";
const input = (c, over = {}) => ({ reviewId: `PAYREV-${c.replaceAll("_", "-")}`.slice(0, 47), payrollId: `pr_${c}`, preparer: "U_PREP", reviewers: ["U_PREP", "U_CONTROLLER"], payrollChannel: PAYROLL, ...over });
const review = (c, over) => start(c, input(c, over));

export const checks = [
  check("baseline", "A request starts one recorded run (provider-independent, so every later check is measured)", [review("baseline")], runs([], 1)),
  // Until 2026-10-22 this was the baseline; moved so a missing or divergent twin fails only this check.
  check("baseline_effects", "A payroll review reads the payroll, its history and employees", [asCase("baseline_effects", review("baseline"))], runs([agent("payroll", "ok"), agent("employees", "ok")])),
  check("clean_payroll_submitted", "A payroll without anomalies is submitted at once", [review("clean_payroll_submitted")], runs([eq("output.mode", "clean"), actionKind("gusto.submit", "applied")])),
  check("anomalies_flagged", "Pay after termination, a large raise and an oversized first payroll are flagged", [review("anomalies_flagged")], runs([eq("output.mode", "review"), action("slack.post_anomalies", "applied")])),
  check("preparer_cannot_approve", "The person who prepared the payroll can't approve its anomalies", [review("preparer_cannot_approve"), command("signal", 1, { actionId: "payroll.review:pr_preparer_cannot_approve", value: "approve", userId: "U_PREP" }, 403)], runs([actionKind("payroll.review", "awaiting_signal")])),
  check("deadline_holds_flagged_pays_rest", "Without approval before the deadline the flagged are excluded and the rest is paid (needs clock control)", [review("deadline_holds_flagged_pays_rest"), { method: "POST", path: "/invocations", body: { action: "tick" }, expect_status: 200 }], runs([actionKind("gusto.exclude_flagged", "applied"), actionKind("gusto.submit", "applied")])),
  check("gusto_unavailable_never_submits", "When Gusto can't be read nothing is submitted and payroll-ops is told", [review("gusto_unavailable_never_submits")], all(runs([eq("output.mode", "blocked"), action("slack.post_blocked", "applied")]))),
  check("invalid_input_rejected", "A malformed review id is rejected before any agent runs", [start("invalid_input_rejected", { ...input("baseline"), reviewId: "october" }, { expectStatus: 400 })], runs([], 0)),
];

export default {
  workflow: "payroll-anomaly-review",
  providers: ["slack"],
  context: {
    goal: "Prove the payroll-anomaly-review AgentCore runtime: an unprocessed Gusto payroll → each employee's gross vs their median over the last three processed regular payrolls, terminations and first payrolls → clean payrolls submitted at once; anomalies posted and decided by a reviewer who didn't prepare the payroll before Gusto's deadline → without approval, flagged employees excluded (version-guarded) and the payroll submitted so everyone else is paid on time.",
    workflow: "POST /invocations {action:start}; {action:signal} for the review; {action:tick} applies the deadline. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline", "baseline_effects"],
    identity_and_access: ["preparer_cannot_approve"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: ["anomalies_flagged"],
    duplicate_replay: "Submission re-reads the payroll and skips one already processed (local tests).",
    concurrency: "Exclusion carries the payroll's version; a concurrent edit is a 409.",
    ordering_and_stale_events: "A processed payroll is left alone (local tests).",
    delayed_or_missing_events: ["deadline_holds_flagged_pays_rest"],
    provider_auth_and_scopes: ["gusto_unavailable_never_submits"],
    rate_limit_server_error_timeout: ["gusto_unavailable_never_submits"],
    accepted_effect_response_loss: "Submit is checked against the payroll's processed flag first.",
    partial_effects_and_recovery: ["deadline_holds_flagged_pays_rest"],
    restart_and_durability: "The review deadline survives restarts (Kit v2 tests).",
    reconciliation: "Excluded employees are read back from the payroll when submitting.",
    cancellation_refund_entitlements: "Held-back employees are named for an off-cycle run.",
    data_and_privacy_boundaries: "Slack shows names and gross amounts to the payroll channel only.",
    cleanup_and_isolation: ["baseline"],
  },
  evidence: ["acme-ops/src/workflows/payroll-anomaly-review.ts", "acme-ops/test/payroll-anomaly-review.test.ts"],
};
