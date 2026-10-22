import { action, actionKind, agent, all, check, command, eq, runs, start } from "./lib.mjs";

// seed() creates every check's own customer segment on the session's Stripe
// twin (metadata acme_segment = the check id): every tenth customer has no
// billing country. full_scan_250 needs the twin to page through 250+
// customers with a working cursor; whether it can is what this check measures.
const CHANNEL = "C0REVOPS01";
const APPROVER = "U_REVOPS_LEAD";

/** Per check: segment size and how many of them miss a country. */
const FIXTURES = {
  baseline: { size: 3, missing: 1 },
  full_scan_250: { size: 250, missing: 25 },
  flag_limit_needs_approval: { size: 12, missing: 12 },
  rerun_flags_nothing: { size: 3, missing: 1 },
  incomplete_scan_refused: { size: 3, missing: 1 },
  stripe_rate_limited: { size: 3, missing: 1 },
};
const segment = (caseId) => caseId.replaceAll("_", "-");
const sweep = (caseId, over = {}) => start(caseId, { segment: segment(caseId), expectedMin: FIXTURES[caseId]?.size ?? 0, revopsChannel: CHANNEL, approvers: [APPROVER], ...over });
const flags = (status, count) => actionKind("stripe.flag_customer", status, count);

export const checks = [
  check("baseline", "A small segment is scanned and its customer without a country is flagged; the sweep is recorded and posted", [sweep("baseline")], runs([eq("phase", "DONE"), eq("output.mode", "flag"), eq("output.segmentCount", 3), flags("applied", 1), action("asana.sweep_record", "applied"), action("slack.post_sweep", "applied")])),
  check("full_scan_250", "A 250-customer segment is read completely across three pages and all 25 customers without a country are flagged", [sweep("full_scan_250")], runs([eq("phase", "DONE"), eq("output.mode", "flag"), eq("output.segmentCount", 250), eq("output.flags", 25), flags("applied", 25)])),
  check("flag_limit_needs_approval", "Past the run's automatic limit (5), flags wait for approval", [sweep("flag_limit_needs_approval", { autoFlagMax: 5 })], runs([eq("phase", "AWAITING_APPROVAL"), flags("applied", 5), flags("pending_approval", 7)])),
  check("rerun_flags_nothing", "A second sweep of the same segment finds everything flagged already and writes nothing", [sweep("rerun_flags_nothing"), start("rerun_flags_nothing", { segment: segment("rerun_flags_nothing"), expectedMin: 3, revopsChannel: CHANNEL, approvers: [APPROVER] }, { runId: "rerun-b-{{run_id}}" })], all(runs([], 2), runs([flags("applied", 1)]), runs([eq("output.mode", "nothing"), flags(null, 0)]))),
  check("incomplete_scan_refused", "When the scan finds fewer customers than the billing system expects, nothing is flagged and RevOps is alerted", [sweep("incomplete_scan_refused", { expectedMin: 50 })], runs([eq("output.mode", "blocked"), flags(null, 0), action("slack.post_sweep", "applied")])),
  check("stripe_rate_limited", "A rate-limited customer list fails the scan closed: nothing is flagged", [sweep("stripe_rate_limited")], all(runs([agent("customer-scan", "failed"), eq("output.mode", "blocked"), flags(null, 0)])), { fault: { provider: "stripe", scenario: "rate_limited", evidence: "refusal" } }),
  check("invalid_input_rejected", "A segment name with spaces is rejected before any agent runs", [start("invalid_input_rejected", { segment: "all customers", expectedMin: 1, revopsChannel: CHANNEL }, { expectStatus: 400 })], runs([], 0)),
];

async function seed(legs, log) {
  const t0 = Date.now();
  let made = 0;
  const create = async (form) => {
    const res = await fetch(`${legs.stripe.base_url}/v1/customers`, { method: "POST", headers: { authorization: `Bearer ${legs.stripe.api_key}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
    const body = await res.json();
    if (!res.ok || !body.id) throw new Error(`seed customer → ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    made++;
  };
  for (const [caseId, f] of Object.entries(FIXTURES)) {
    // Bounded parallelism: the twin creates about one customer per 0.6 s per connection.
    const jobs = Array.from({ length: f.size }, (_, i) => () => create({ email: `${segment(caseId)}-${i}@scale.example.com`, "metadata[acme_segment]": segment(caseId), ...(i % Math.floor(f.size / f.missing) === 0 ? {} : { "address[country]": "US", "address[line1]": "1 Main St" }) }));
    let next = 0;
    await Promise.all(Array.from({ length: 8 }, async () => { while (next < jobs.length) await jobs[next++](); }));
  }
  log("seed", made, "customers in", Math.round((Date.now() - t0) / 1000), "s");
  return { made };
}

export default {
  workflow: "customer-data-sweep",
  providers: ["stripe", "asana", "slack"],
  seed,
  context: {
    goal: "Prove the customer-data-sweep AgentCore runtime: page through every Stripe customer with cursor pagination (100 per page), keep a segment's customers, refuse an incomplete scan (stalled cursor or fewer records than expected), flag missing billing country and duplicate emails in metadata with a per-run automatic-write limit (approval beyond it); record in Asana and post to Slack.",
    workflow: "POST /invocations {action:start} scans, flags automatically up to the limit and parks the rest; {action:decide} releases them. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: "Only metadata flags are written, to customers the scan read; approvals as in every runtime.",
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: ["full_scan_250", "flag_limit_needs_approval"],
    duplicate_replay: ["rerun_flags_nothing"],
    concurrency: "One sweep per segment and night; flags are idempotent metadata writes.",
    ordering_and_stale_events: "No events; the scan is a point-in-time read.",
    delayed_or_missing_events: ["incomplete_scan_refused"],
    provider_auth_and_scopes: ["stripe_rate_limited"],
    rate_limit_server_error_timeout: ["stripe_rate_limited"],
    accepted_effect_response_loss: "Metadata flags are safe to repeat.",
    partial_effects_and_recovery: ["flag_limit_needs_approval"],
    restart_and_durability: "Parked flags survive restarts like every other runtime; not re-measured here.",
    reconciliation: "stripe.flag_customer reconciles the flag (local tests).",
    cancellation_refund_entitlements: "No money or entitlements change.",
    data_and_privacy_boundaries: "Slack and Asana get counts only, never customer emails.",
    cleanup_and_isolation: ["baseline", "full_scan_250"],
  },
  evidence: ["acme-ops/src/workflows/customer-data-sweep.ts", "acme-ops/test/customer-data-sweep.test.ts"],
};
