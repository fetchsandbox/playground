import { action, actionKind, agent, all, check, command, eq, runs, start } from "./lib.mjs";

// Executable expectations for the partner sanctions re-screen (Stripe Connect
// payout holds as precaution and compensation, analyst and MLRO signals with
// segregation of duties, clearance memory across sweeps). Stripe and Slack have
// FetchSandbox twins; the Consolidated Screening List doesn't, so every check
// that needs a match measures that gap. seed() creates each check's connected
// accounts tagged metadata[acme_program].
const COMPLIANCE = "C0COMPLY001";
const program = (c) => `kyc-${c.replaceAll("_", "-")}`.slice(0, 60);
const rescreen = (c, over = {}) => start(c, { rescreenId: `KYC-${c.replaceAll("_", "-")}`.slice(0, 44), program: program(c), complianceChannel: COMPLIANCE, analysts: ["U_ANALYST"], mlro: ["U_MLRO", "U_ANALYST"], ...over });
const FIXTURES = {
  baseline: ["Harbor Supplies"],
  accounts_in_program_screened: ["Harbor Supplies", "Juniper Crafts"],
  strong_match_held: ["Volga Trading"],
  analyst_clears_false_positive: ["Nordic Volga Foods"],
  mlro_distinct_from_analyst: ["Volga Trading"],
  screening_unavailable_blocks: ["Harbor Supplies"],
};

export const checks = [
  check("baseline", "A re-screen reads the program's accounts and posts a summary", [rescreen("baseline")], runs([agent("screening", "ok"), eq("output.mode", "rescreen"), action("slack.post_rescreen", "applied")])),
  check("accounts_in_program_screened", "Only connected accounts in the program are screened", [rescreen("accounts_in_program_screened")], runs([eq("output.accounts", 2)])),
  check("strong_match_held", "A strong sanctions match holds payouts at once", [rescreen("strong_match_held")], runs([eq("output.held", 1), actionKind("stripe.precautionary_hold", "applied")])),
  check("analyst_clears_false_positive", "An analyst's false-positive decision records the clearance", [rescreen("analyst_clears_false_positive"), command("signal", 1, { actionId: "compliance.review:ACCT_analyst_clears_false_positive", value: "reject", userId: "U_ANALYST" })], runs([actionKind("stripe.clear", "applied")])),
  check("mlro_distinct_from_analyst", "The analyst who confirmed a match can't also take the SAR decision", [rescreen("mlro_distinct_from_analyst"), command("signal", 1, { actionId: "compliance.review:ACCT_mlro_distinct_from_analyst", value: "approve", userId: "U_ANALYST" }), command("signal", 1, { actionId: "mlro.sar_decision:ACCT_mlro_distinct_from_analyst", value: "approve", userId: "U_ANALYST" }, 403)], runs([actionKind("mlro.sar_decision", "awaiting_signal")])),
  check("screening_unavailable_blocks", "When screening can't run nothing is screened and compliance is told", [rescreen("screening_unavailable_blocks")], all(runs([agent("screening", "failed"), eq("output.mode", "blocked"), action("slack.post_rescreen", "applied")]))),
  check("invalid_input_rejected", "A program with spaces is rejected before any agent runs", [start("invalid_input_rejected", { rescreenId: "KYC-bad", program: "all partners", complianceChannel: COMPLIANCE, analysts: ["U_ANALYST"], mlro: ["U_MLRO"] }, { expectStatus: 400 })], runs([], 0)),
];

async function seed(legs, log) {
  const trail = [];
  const ids = {};
  for (const [c, names] of Object.entries(FIXTURES)) {
    for (const name of names) {
      const res = await fetch(`${legs.stripe.base_url}/v1/accounts`, { method: "POST", headers: { authorization: `Bearer ${legs.stripe.api_key}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ type: "custom", country: "US", "business_profile[name]": name, "metadata[acme_program]": program(c), "capabilities[transfers][requested]": "true" }).toString() });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch {}
      if (!res.ok || !body?.id) { trail.push(`account ${name}: ${res.status} ${text.slice(0, 80)}`); continue; }
      ids[c] ??= body.id;
    }
  }
  for (const chk of checks) {
    if (!ids[chk.id]) continue;
    Object.assign(chk, JSON.parse(JSON.stringify(chk).replaceAll(`ACCT_${chk.id}`, ids[chk.id])));
  }
  log("seed", Object.keys(ids).length, "programs;", trail.slice(0, 6).join("; "));
  return { ids, trail };
}

export default {
  workflow: "customer-kyc-rescreen",
  providers: ["stripe", "slack"],
  seed,
  context: {
    goal: "Prove the customer-kyc-rescreen AgentCore runtime: connected accounts in a program (metadata.acme_program) → Consolidated Screening List search per account → strong matches (≥95) put payouts on manual at once → analyst decides (approve = true match, reject = false positive) with reminders every 3 days → false positives recorded as a clearance for that exact hit set for 180 days and the precautionary hold released → true matches held and routed to an MLRO who isn't the analyst for the SAR decision within 30 days of detection.",
    workflow: "POST /invocations {action:start}; {action:signal} for analyst and MLRO decisions; {action:tick} fires reminders and the SAR deadline. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["mlro_distinct_from_analyst"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: ["accounts_in_program_screened"],
    duplicate_replay: "A cleared hit set is not raised again until the clearance expires (local tests).",
    concurrency: "Signals are compare-and-swap on the run.",
    ordering_and_stale_events: "A hold is only released to the schedule recorded when it was placed.",
    delayed_or_missing_events: "Reminders every 3 days; a missing SAR decision fails at 30 days (local tests).",
    provider_auth_and_scopes: ["screening_unavailable_blocks"],
    rate_limit_server_error_timeout: ["screening_unavailable_blocks"],
    accepted_effect_response_loss: "Payout schedule changes are idempotent sets.",
    partial_effects_and_recovery: ["analyst_clears_false_positive"],
    restart_and_durability: "Screening is checkpointed per account; signals and timers survive restarts (Kit v2 tests).",
    reconciliation: "Holds read the current schedule before changing it.",
    cancellation_refund_entitlements: ["strong_match_held"],
    data_and_privacy_boundaries: "Only account ids and list names are posted.",
    cleanup_and_isolation: ["baseline"],
  },
  evidence: ["acme-ops/src/workflows/customer-kyc-rescreen.ts", "acme-ops/test/customer-kyc-rescreen.test.ts"],
};
