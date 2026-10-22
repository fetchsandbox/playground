import { action, actionKind, agent, all, blocked, check, command, eq, restart, runs, start } from "./lib.mjs";

// seed() creates the partners' connected accounts on the session's Stripe twin
// (ids replace the acct_seed_* placeholders). Every check pays into its own
// transfer group PO-<check>, so checks never share transfers, and transfer
// counts are asserted on the twin itself, independently of the app's record.
const CHANNEL = "C0BILLING01";
const APPROVER = "U_CONTROLLER";

const group = (caseId) => `PO-${caseId.replaceAll("_", "-")}`.slice(0, 43);
const acct = (caseId, n) => `acct_seed_${caseId}_${n}`;
const run = (caseId, partners, over = {}) => ({
  payoutRunId: group(caseId),
  period: "2026-10",
  partners: partners.map(([n, amountMinor]) => ({ partnerId: `P-10${n}`, account: acct(caseId, n), amountMinor })),
  financeChannel: CHANNEL,
  approvers: [APPROVER],
  ...over,
});
const SMALL = [[1, 120_000], [2, 45_000]];
const LARGE = [[1, 400_000], [2, 45_000]];
const pay = (caseId, partners = SMALL, over) => start(caseId, run(caseId, partners, over));
const transfer = (status, count = 1, extra = []) => actionKind("stripe.transfer", status, count, extra);
/** Transfers that exist on the Stripe twin to partner n's connected account in this check. */
const onTwin = (caseId, n, count) => ({ provider: "stripe", collection: "transfers", assertion: { select: "records[*]", count, required: true, where: [eq("destination", acct(caseId, n))] } });

const withTwin = (c, provider_assertions) => ({ ...c, provider_assertions });

/**
 * Every Stripe call is held until the client gives up (~15 s) and retried, so the
 * run outlasts the verifier's request: start it without waiting and poll saved state.
 */
function eventually(c, seconds = 150) {
  for (const a of c.actions) if (a.body?.action === "start") a.body.wait = false;
  const leaf = c.assertion.all_of ? c.assertion.all_of[0] : c.assertion;
  Object.assign(leaf, { repeat: 1, stable_under_repeat: false });
  c.observation_deadline_seconds = seconds;
  return c;
}

function faulted(id, name, provider, scenario, assertions, evidence = "refusal", partners = SMALL) {
  return check(id, name, [pay(id, partners)], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence } });
}

/** Which partners (and so connected accounts) each check pays. */
const FIXTURES = {
  baseline: SMALL,
  lost_response_same_transfer: [[1, 75_000]],
  rerun_pays_nothing: SMALL,
  large_transfer_parked: LARGE,
  large_transfer_approved: LARGE,
  large_transfer_rejected: LARGE,
  approve_by_stranger_refused: LARGE,
  missing_account_skipped: [[1, 10_000]],
  ceiling_halts: [[1, 25_000_001]],
  duplicate_start: SMALL,
  concurrent_start: SMALL,
  stripe_auth_failure: SMALL,
  asana_rate_limited: SMALL,
  slack_rate_limited: SMALL,
  restart_while_parked: LARGE,
};

export const checks = [
  check("baseline", "Each partner is paid once by a transfer to their connected account; the run is recorded and posted", [pay("baseline")], runs([eq("phase", "DONE"), eq("outcome", "ok"), transfer("applied", 2, [eq("attempts", 1)]), action("asana.payout_record", "applied"), action("slack.post_payout_run", "applied")]), { provider_assertions: [onTwin("baseline", 1, 1), onTwin("baseline", 2, 1)] }),
  withTwin(eventually(faulted(
    "lost_response_same_transfer",
    "The transfer is accepted but its response is held until the client gives up; the retry returns the same transfer and the partner is paid exactly once",
    "stripe",
    "recovery_timeout",
    [eq("phase", "DONE"), transfer("applied", 1, [eq("attempts", 1)])],
    "accepted_response_retry",
    FIXTURES.lost_response_same_transfer,
  )), [onTwin("lost_response_same_transfer", 1, 1)]),
  check(
    "rerun_pays_nothing",
    "Re-running the same payout run (a new trigger) finds every partner already paid and pays nothing",
    [pay("rerun_pays_nothing"), start("rerun_pays_nothing", run("rerun_pays_nothing", SMALL), { runId: "rerun-b-{{run_id}}" })],
    all(runs([], 2), runs([transfer("applied", 2)]), runs([transfer(null, 0), action("slack.post_payout_run", "applied")])),
    { provider_assertions: [onTwin("rerun_pays_nothing", 1, 1), onTwin("rerun_pays_nothing", 2, 1)] },
  ),
  check("large_transfer_parked", "A transfer above $2,500 waits for approval; the small one goes out", [pay("large_transfer_parked", LARGE)], runs([eq("phase", "AWAITING_APPROVAL"), action("stripe.transfer:P-101", "pending_approval"), action("stripe.transfer:P-102", "applied")]), { provider_assertions: [onTwin("large_transfer_parked", 1, 0), onTwin("large_transfer_parked", 2, 1)] }),
  check("large_transfer_approved", "The controller's approval pays the large transfer exactly once", [pay("large_transfer_approved", LARGE), command("decide", 1, { decision: "approve", userId: APPROVER })], runs([eq("phase", "DONE"), action("stripe.transfer:P-101", "applied", 1, [eq("attempts", 1)])]), { provider_assertions: [onTwin("large_transfer_approved", 1, 1), onTwin("large_transfer_approved", 2, 1)] }),
  check("large_transfer_rejected", "A rejected large transfer is never paid", [pay("large_transfer_rejected", LARGE), command("decide", 1, { decision: "reject", userId: APPROVER })], runs([eq("phase", "REJECTED"), action("stripe.transfer:P-101", "rejected")]), { provider_assertions: [onTwin("large_transfer_rejected", 1, 0), onTwin("large_transfer_rejected", 2, 1)] }),
  check("approve_by_stranger_refused", "Someone who is not an approver cannot release a transfer", [pay("approve_by_stranger_refused", LARGE), command("decide", 1, { decision: "approve", userId: "U_INTERN" }, 403)], runs([eq("phase", "AWAITING_APPROVAL"), action("stripe.transfer:P-101", "pending_approval")])),
  check("missing_account_skipped", "A partner whose connected account doesn't exist is skipped, not paid", [start("missing_account_skipped", run("missing_account_skipped", [], { partners: [{ partnerId: "P-101", account: acct("missing_account_skipped", 1), amountMinor: 10_000 }, { partnerId: "P-109", account: "acct_doesnotexist0000", amountMinor: 10_000 }] }))], runs([eq("phase", "DONE"), action("stripe.transfer:P-101", "applied"), actionKind("stripe.transfer", null, 1)]), { provider_assertions: [onTwin("missing_account_skipped", 1, 1)] }),
  check("ceiling_halts", "A run beyond the automation ceiling pays nothing and escalates", [pay("ceiling_halts", FIXTURES.ceiling_halts)], runs([eq("phase", "DONE"), transfer(null, 0), action("asana.payout_record", "applied"), action("slack.post_payout_run", "applied")]), { provider_assertions: [onTwin("ceiling_halts", 1, 0)] }),
  check("duplicate_start", "A re-delivered payout trigger pays once", [pay("duplicate_start"), pay("duplicate_start")], runs([transfer("applied", 2, [eq("attempts", 1)])]), { provider_assertions: [onTwin("duplicate_start", 1, 1), onTwin("duplicate_start", 2, 1)] }),
  check("concurrent_start", "Four simultaneous deliveries of one payout run pay once", [pay("concurrent_start"), { ...pay("concurrent_start"), concurrency: 4 }], runs([transfer("applied", 2, [eq("attempts", 1)])]), { provider_assertions: [onTwin("concurrent_start", 1, 1), onTwin("concurrent_start", 2, 1)] }),
  check("invalid_input_rejected", "A statement listing a partner twice is rejected before any agent runs", [start("invalid_input_rejected", run("invalid_input_rejected", [[1, 100], [1, 100]]), { expectStatus: 400 })], runs([], 0)),
  faulted("stripe_auth_failure", "Without Stripe nothing is paid; the run is still recorded and posted", "stripe", "auth_failure", [agent("ledger-check", "failed"), transfer(null, 0), action("slack.post_payout_run", "applied")]),
  faulted("asana_rate_limited", "An Asana outage loses the record only; partners are still paid", "asana", "rate_limited", [action("asana.payout_record", "failed"), transfer("applied", 2)]),
  faulted("slack_rate_limited", "Slack rate limiting fails the post only", "slack", "rate_limited", [action("slack.post_payout_run", "failed"), transfer("applied", 2)]),
  check("restart_while_parked", "A transfer parked for approval survives a real runtime restart and is paid once when approved", [pay("restart_while_parked", LARGE), restart, command("decide", 1, { decision: "approve", userId: APPROVER })], runs([eq("phase", "DONE"), action("stripe.transfer:P-101", "applied", 1, [eq("attempts", 1)])])),
  blocked("transfer_reversal_readback", "Reconcile flags a transfer that was reversed after it was paid", "observation_missing", "The Stripe twin returns sample reversal fields on GET /v1/transfers/{id} (reversed: true, amount_reversed unrelated to the transfer), so the read-back can't distinguish a real reversal. Covered by local tests.", ["acme-ops/src/workflows/partner-payout-run.ts stripe.transfer reconcile", "GET /v1/transfers/{id} on the twin right after create: reversed true, amount_reversed 54"]),
];

/** The partners' connected accounts, created on the session's Stripe twin. */
async function seed(legs, log) {
  const leg = legs.stripe;
  const out = {};
  for (const [caseId, partners] of Object.entries(FIXTURES)) {
    for (const [n] of partners) {
      const res = await fetch(`${leg.base_url}/v1/accounts`, { method: "POST", headers: { authorization: `Bearer ${leg.api_key}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ type: "express", email: `partner-${n}-${caseId.replaceAll("_", "-")}@payout.test` }).toString() });
      const body = await res.json();
      if (!res.ok || !body.id) throw new Error(`seed account for ${caseId} → ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
      out[acct(caseId, n)] = body.id;
    }
  }
  // Point every check, and its provider assertions, at the real account ids.
  for (const c of checks) {
    for (const a of c.actions ?? []) for (const p of a.body?.input?.partners ?? []) if (out[p.account]) p.account = out[p.account];
    for (const pa of c.provider_assertions ?? []) for (const w of pa.assertion.where ?? []) if (out[w.equals]) w.equals = out[w.equals];
  }
  log("seed", Object.keys(out).length, "connected accounts");
  return out;
}

export default {
  workflow: "partner-payout-run",
  providers: ["stripe", "slack", "asana"],
  seed,
  // The runtime's provider timeout (default 15 s) must fire while the twin holds an
  // accepted response, so the client really disconnects and retries with the same key.
  appEnv: { PROVIDER_TIMEOUT_MS: "3000" },
  context: {
    goal: "Prove the partner-payout-run AgentCore runtime: month-end partner statement → parallel Stripe connected-account checks and transfer-ledger read → one Stripe transfer per partner under single/run limits (approval above), a hard ceiling that pays nothing, Asana record and Slack post; a lost transfer response is retried with the same idempotency key and never becomes a second payment.",
    workflow: "POST /invocations {action:start} plans and pays automatic transfers and parks the rest; {action:decide} releases or withholds them. GET /verify/runs/{run}/cases/{case}/runs reads saved run state; transfers are also asserted on the Stripe twin by transfer group.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["approve_by_stranger_refused", "missing_account_skipped"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: ["large_transfer_parked", "ceiling_halts"],
    duplicate_replay: ["duplicate_start", "rerun_pays_nothing"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: "A payout run is one statement; the transfer ledger is re-read at write time, so a transfer made by another run since planning is reused, not repeated (local tests).",
    delayed_or_missing_events: "No inbound provider events.",
    provider_auth_and_scopes: ["stripe_auth_failure"],
    rate_limit_server_error_timeout: ["asana_rate_limited", "slack_rate_limited"],
    accepted_effect_response_loss: ["lost_response_same_transfer"],
    partial_effects_and_recovery: ["asana_rate_limited", "lost_response_same_transfer"],
    restart_and_durability: ["restart_while_parked"],
    reconciliation: ["transfer_reversal_readback"],
    cancellation_refund_entitlements: ["large_transfer_approved", "large_transfer_rejected"],
    data_and_privacy_boundaries: "Partner amounts and connected-account ids only; no personal data is read or written.",
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: ["acme-ops/src/workflows/partner-payout-run.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/http.ts", "acme-ops/src/providers/{stripe,slack,work}.ts"],
};
