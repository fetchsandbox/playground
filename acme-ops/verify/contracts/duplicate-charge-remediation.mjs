import { action, actionKind, agent, all, blocked, check, command, eq, restart, runs, start } from "./lib.mjs";

// Stripe fixtures are seeded per check by seed(): customer dup-<check>@billing.test
// with payment intents confirmed on the twin (real charges, stamped "now"), so
// no two checks share payments. No window is given, so the runtime scans the
// 72 hours before each run, which brackets the payments seeded just before.
const CHANNEL = "C0BILLING01";
const APPROVER = "U_CONTROLLER";

const email = (caseId, n = 1) => `dup-${caseId.replaceAll("_", "-")}${n > 1 ? `-${n}` : ""}@billing.test`;
const incident = (caseId, over = {}) => ({
  incidentId: `INC-${caseId.replaceAll("_", "-")}`.slice(0, 64),
  description: "Payment retry job ran twice and charged customers a second time.",
  customers: [email(caseId)],
  financeChannel: CHANNEL,
  approvers: [APPROVER],
  ...over,
});
const refund = (status, count = 1, extra = []) => actionKind("stripe.refund_duplicate", status, count, extra);
const noRefund = actionKind("stripe.refund_duplicate", null, 0);

function faulted(id, name, provider, scenario, assertions) {
  return check(id, name, [start(id, incident(id))], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });
}

/** Per check: which customers get which payments. */
const PAIR = [{ amount: 4900, ref: "in_oct" }, { amount: 4900, ref: "in_oct" }];
const LARGE = [{ amount: 120000, ref: "in_annual" }, { amount: 120000, ref: "in_annual" }];
const FIXTURES = {
  baseline: [PAIR],
  refund_reconciled: [PAIR],
  large_refund_parked: [LARGE],
  large_refund_approved: [LARGE],
  large_refund_rejected: [LARGE],
  approve_by_stranger_refused: [LARGE],
  restart_while_parked: [LARGE],
  rerun_refunds_nothing: [PAIR],
  ambiguous_not_refunded: [[{ amount: 4900 }, { amount: 4900 }]],
  different_purchase_kept: [[...PAIR, { amount: 1500, ref: "in_addon" }]],
  two_customers: [PAIR, [{ amount: 9900, ref: "in_team" }, { amount: 9900, ref: "in_team" }]],
  ceiling_halts: [[{ amount: 2_600_000, ref: "in_enterprise" }, { amount: 2_600_000, ref: "in_enterprise" }]],
  duplicate_start: [PAIR],
  concurrent_start: [PAIR],
  stripe_auth_failure: [PAIR],
  hubspot_rate_limited: [PAIR],
  gmail_auth_failure: [PAIR],
  slack_rate_limited: [PAIR],
};

export const checks = [
  check("baseline", "A purchase charged twice is refunded once, the customer notice is drafted, and the remediation is recorded and posted", [start("baseline", incident("baseline"))], all(runs([eq("phase", "DONE"), eq("outcome", "ok"), refund("applied", 1, [eq("attempts", 1)]), actionKind("gmail.draft_notice", "applied"), action("asana.remediation_record", "applied"), action("slack.post_digest", "applied")]))),
  check("refund_reconciled", "Reconcile reads the refund back from Stripe with the planned amount", [start("refund_reconciled", incident("refund_reconciled")), command("reconcile", 1)], runs([refund("applied", 1, [eq("reconciled", "match")])])),
  check("large_refund_parked", "A refund above the single-refund limit waits for approval, and so does that customer's notice", [start("large_refund_parked", incident("large_refund_parked"))], runs([eq("phase", "AWAITING_APPROVAL"), refund("pending_approval"), actionKind("gmail.draft_notice", "pending_approval")])),
  check("large_refund_approved", "The controller's approval issues the large refund exactly once", [start("large_refund_approved", incident("large_refund_approved")), command("decide", 1, { decision: "approve", userId: APPROVER })], runs([eq("phase", "DONE"), refund("applied", 1, [eq("gate", "approval"), eq("attempts", 1)]), actionKind("gmail.draft_notice", "applied")])),
  check("large_refund_rejected", "A rejected large refund is never issued", [start("large_refund_rejected", incident("large_refund_rejected")), command("decide", 1, { decision: "reject", userId: APPROVER })], runs([eq("phase", "REJECTED"), refund("rejected")])),
  check("approve_by_stranger_refused", "Someone who is not an approver cannot release a refund", [start("approve_by_stranger_refused", incident("approve_by_stranger_refused")), command("decide", 1, { decision: "approve", userId: "U_INTERN" }, 403)], runs([eq("phase", "AWAITING_APPROVAL"), refund("pending_approval")])),
  check(
    "rerun_refunds_nothing",
    "Running the same incident again (a new trigger) finds the duplicate already refunded and refunds nothing",
    [start("rerun_refunds_nothing", incident("rerun_refunds_nothing"), { runId: "rerun-a-{{run_id}}" }), start("rerun_refunds_nothing", incident("rerun_refunds_nothing"), { runId: "rerun-b-{{run_id}}" })],
    all(runs([], 2), runs([refund("applied")]), runs([noRefund, action("slack.post_digest", "applied")])),
  ),
  check("ambiguous_not_refunded", "Same-amount payments with nothing saying what they were for are left to a person", [start("ambiguous_not_refunded", incident("ambiguous_not_refunded"))], runs([eq("phase", "DONE"), noRefund, action("slack.post_digest", "applied")])),
  check("different_purchase_kept", "A different purchase in the same window is not refunded", [start("different_purchase_kept", incident("different_purchase_kept"))], runs([refund("applied", 1)])),
  check("two_customers", "Duplicates for two customers are refunded in parallel, one notice each", [start("two_customers", incident("two_customers", { customers: [email("two_customers"), email("two_customers", 2)] }))], runs([eq("phase", "DONE"), refund("applied", 2), actionKind("gmail.draft_notice", "applied", 2)])),
  check("ceiling_halts", "An incident beyond the automation ceiling refunds nothing and escalates", [start("ceiling_halts", incident("ceiling_halts"))], runs([eq("phase", "DONE"), noRefund, action("asana.remediation_record", "applied"), action("slack.post_digest", "applied")])),
  check("unknown_customer", "An address with no Stripe customer is reported, not refunded", [start("unknown_customer", incident("unknown_customer"))], runs([eq("phase", "DONE"), noRefund])),
  check("duplicate_start", "A re-delivered incident trigger refunds once", [start("duplicate_start", incident("duplicate_start")), start("duplicate_start", incident("duplicate_start"))], runs([refund("applied", 1, [eq("attempts", 1)])])),
  check("concurrent_start", "Four simultaneous deliveries of one incident refund once", [start("concurrent_start", incident("concurrent_start")), { ...start("concurrent_start", incident("concurrent_start")), concurrency: 4 }], runs([refund("applied", 1, [eq("attempts", 1)])])),
  check("invalid_window_rejected", "An incident window longer than seven days is rejected before any agent runs", [start("invalid_window_rejected", incident("invalid_window_rejected", { window: { from: "2026-08-01T00:00:00Z", to: "2026-10-01T00:00:00Z" } }), { expectStatus: 400 })], runs([], 0)),
  faulted("stripe_auth_failure", "Without Stripe nothing is refunded; the incident is still recorded and posted", "stripe", "auth_failure", [agent("charge-scan", "failed"), noRefund, action("slack.post_digest", "applied")]),
  faulted("hubspot_rate_limited", "A CRM outage only loses account context; refunds still go out", "hubspot", "rate_limited", [agent("account-context", "failed"), refund("applied")]),
  faulted("gmail_auth_failure", "A mailbox failure fails the notice draft only", "gmail", "auth_failure", [actionKind("gmail.draft_notice", "failed"), refund("applied")]),
  faulted("slack_rate_limited", "Slack rate limiting fails the digest only", "slack", "rate_limited", [action("slack.post_digest", "failed"), refund("applied")]),
  check("restart_while_parked", "A refund parked for approval survives a real runtime restart and is issued once when approved", [start("restart_while_parked", incident("restart_while_parked")), restart, command("decide", 1, { decision: "approve", userId: APPROVER })], runs([eq("phase", "DONE"), refund("applied", 1, [eq("attempts", 1)])])),
  blocked("disputed_charge_excluded", "A duplicate whose charge is disputed is excluded from refunds", "setup_missing", "The Stripe twin can't open a dispute on a charge created in the session (pm_card_createDispute is not simulated; seeded disputes reference charges that don't exist). Covered by local tests.", ["acme-ops/src/workflows/duplicate-charge-remediation.ts planFrom", "POST /v1/payment_intents payment_method=pm_card_createDispute → resource_missing on the twin"]),
  blocked("dispute_outage_fails_closed", "If the dispute list can't be read, nothing is refunded", "setup_missing", "Twin faults apply to the whole Stripe twin, so the dispute read can't fail on its own while the payment scan succeeds. Covered by local tests.", ["acme-ops/src/workflows/duplicate-charge-remediation.ts dispute-check", "set_scenario arms a provider, not an endpoint"]),
  blocked("manual_refund_race", "A duplicate refunded by hand between scan and refund is not refunded again", "setup_missing", "Needs a write to the twin between two steps of one run. Covered by local tests (the refund re-checks the refundable amount at write time).", ["acme-ops/src/workflows/duplicate-charge-remediation.ts stripe.refund_duplicate execute"]),
];

/** One Stripe customer per check (two for two_customers), each with its payments. */
async function seed(legs, log) {
  const leg = legs.stripe;
  const call = async (path, form) => {
    const res = await fetch(`${leg.base_url}${path}`, { method: "POST", headers: { authorization: `Bearer ${leg.api_key}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
    const body = await res.json();
    if (!res.ok || !body.id) throw new Error(`seed ${path} → ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
    return body;
  };
  const out = {};
  for (const [caseId, customers] of Object.entries(FIXTURES)) {
    out[caseId] = [];
    for (const [i, payments] of customers.entries()) {
      const cus = await call("/v1/customers", { email: email(caseId, i + 1), name: "Sam Billing" });
      for (const p of payments) {
        const pi = await call("/v1/payment_intents", { amount: String(p.amount), currency: "usd", customer: cus.id, confirm: "true", payment_method: "pm_card_visa", ...(p.ref ? { "metadata[invoice]": p.ref } : {}) });
        if (pi.status !== "succeeded" || !pi.latest_charge) throw new Error(`seed payment for ${caseId} is ${pi.status}`);
        out[caseId].push(pi.id);
      }
    }
  }
  log("seed", Object.keys(out).length, "checks with payments");
  return out;
}

export default {
  workflow: "duplicate-charge-remediation",
  providers: ["stripe", "hubspot", "gmail", "slack", "asana"],
  seed,
  context: {
    goal: "Prove the duplicate-charge-remediation AgentCore runtime: billing incident → parallel Stripe payment scan, Stripe dispute check, HubSpot account context → per-duplicate refunds under single/batch limits (approval above), a hard ceiling that refunds nothing, customer notice drafts released only after refunds, Asana record and Slack digest.",
    workflow: "POST /invocations {action:start} scans, plans and applies automatic refunds and parks the rest; {action:decide} releases or withholds them; {action:reconcile} reads refunds back. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["approve_by_stranger_refused", "unknown_customer"],
    schema_and_value_boundaries: ["invalid_window_rejected", "ambiguous_not_refunded"],
    amount_currency_quantity: ["large_refund_parked", "ceiling_halts", "different_purchase_kept"],
    duplicate_replay: ["duplicate_start", "rerun_refunds_nothing"],
    concurrency: ["concurrent_start", "two_customers"],
    ordering_and_stale_events: ["manual_refund_race"],
    delayed_or_missing_events: "The incident trigger carries the window and customers; nothing waits on provider events.",
    provider_auth_and_scopes: ["stripe_auth_failure", "gmail_auth_failure"],
    rate_limit_server_error_timeout: ["hubspot_rate_limited", "slack_rate_limited"],
    accepted_effect_response_loss: "Each refund looks for its own refund (metadata acme_incident) before creating one, and carries an Idempotency-Key; covered by local tests.",
    partial_effects_and_recovery: ["gmail_auth_failure", "dispute_outage_fails_closed"],
    restart_and_durability: ["restart_while_parked"],
    reconciliation: ["refund_reconciled"],
    cancellation_refund_entitlements: ["large_refund_approved", "large_refund_rejected", "disputed_charge_excluded"],
    data_and_privacy_boundaries: "Run summaries and Slack carry a customer hash, not the address; notices are drafts a person sends.",
    cleanup_and_isolation: ["baseline", "two_customers"],
  },
  evidence: ["acme-ops/src/workflows/duplicate-charge-remediation.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/providers/{stripe,hubspot,google,slack,work}.ts"],
};
