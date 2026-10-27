import { action, actionKind, agent, all, check, command, eq, runs, start } from "./lib.mjs";

// Executable expectations for a supplier bank-detail change (Kit v2: signals,
// timers, after/requires, hash-chained audit). The runtime needs NetSuite
// (vendor record, payment hold), Twilio Verify (callback), Plaid (account
// ownership) and a sanctions list. FetchSandbox currently has twins only for
// Plaid, Gmail, Slack and Asana in this set, so the receipt shows exactly which
// promised behaviours can't be measured yet. Signals are sent as the runtime's
// real `signal` command; deadlines need the verifier to move the runtime's
// clock, which FetchSandbox doesn't offer yet (the tick is sent anyway).
const AP = "C0FINANCE01";
const SEC = "C0SECURITY1";
const request = (caseId, over = {}) => ({
  changeId: `BC-${caseId.replaceAll("_", "-")}`.slice(0, 43),
  vendorId: "731",
  submittedBy: "U_AP_CLERK",
  source: "email",
  requestEmail: "billing@northwind.example",
  newBank: { accountName: "Northwind Traders LLC", last4: "9012", vaultToken: "tok_bank_9012", plaidAccessToken: "access-sandbox-northwind" },
  verifiers: ["U_AP_CLERK", "U_AP_VERIFIER"],
  apChannel: AP,
  securityChannel: SEC,
  approvers: ["U_TREASURY", "U_AP_VERIFIER"],
  ...over,
});
const change = (caseId, over) => start(caseId, request(caseId, over));
const id = (caseId, kind) => {
  const c = request(caseId).changeId;
  return { hold: "netsuite.hold_payments:731", call: `twilio.callback:${c}`, confirm: `ap.confirm_callback:${c}`, approve: `treasury.approve:${c}`, apply: `netsuite.apply_bank_change:${c}`, release: "netsuite.release_hold:731" }[kind];
};
const signal = (caseId, kind, userId, value = "approve", status = 200) => command("signal", 1, { actionId: id(caseId, kind), value, userId }, status);

export const checks = [
  check("baseline", "A bank-change request is recorded for AP and posted", [change("baseline")], runs([action("asana.change_record", "applied"), actionKind("slack.post_change", "applied")])),
  check("payments_held_while_verifying", "Payments to the supplier are held as soon as the request arrives", [change("payments_held_while_verifying")], runs([agent("vendor-record", "ok"), eq("output.mode", "verify"), action(id("payments_held_while_verifying", "hold"), "applied")])),
  check("callback_to_number_on_file", "AP's callback goes to the phone number on file, never one from the request", [change("callback_to_number_on_file")], runs([action(id("callback_to_number_on_file", "call"), "applied")])),
  check("submitter_cannot_confirm", "The person who entered the change can't confirm its callback", [change("submitter_cannot_confirm"), signal("submitter_cannot_confirm", "confirm", "U_AP_CLERK", "approve", 403)], runs([action(id("submitter_cannot_confirm", "confirm"), "awaiting_signal")])),
  check("verifier_cannot_also_approve", "The AP verifier who confirmed the callback can't also give the treasury approval", [change("verifier_cannot_also_approve"), signal("verifier_cannot_also_approve", "confirm", "U_AP_VERIFIER"), signal("verifier_cannot_also_approve", "approve", "U_AP_VERIFIER", "approve", 403)], runs([action(id("verifier_cannot_also_approve", "approve"), "awaiting_signal")])),
  check("two_person_rule_applies_change", "Callback confirmed by AP and approved by treasury: the new bank details apply and the hold is released", [change("two_person_rule_applies_change"), signal("two_person_rule_applies_change", "confirm", "U_AP_VERIFIER"), signal("two_person_rule_applies_change", "approve", "U_TREASURY")], runs([eq("phase", "DONE"), action(id("two_person_rule_applies_change", "apply"), "applied"), action(id("two_person_rule_applies_change", "release"), "applied")])),
  check("treasury_rejection_keeps_old_account", "A treasury rejection keeps the account on file and releases the hold", [change("treasury_rejection_keeps_old_account"), signal("treasury_rejection_keeps_old_account", "confirm", "U_AP_VERIFIER"), signal("treasury_rejection_keeps_old_account", "approve", "U_TREASURY", "reject")], runs([action(id("treasury_rejection_keeps_old_account", "apply"), "skipped"), action(id("treasury_rejection_keeps_old_account", "release"), "applied")])),
  check("callback_deadline_rejects", "Five days without a confirmed callback: the change is not applied (needs the verifier to advance the runtime's clock)", [change("callback_deadline_rejects"), { method: "POST", path: "/invocations", body: { action: "tick" }, expect_status: 200 }], runs([action(id("callback_deadline_rejects", "confirm"), "rejected"), action(id("callback_deadline_rejects", "apply"), "skipped")])),
  check("ownership_checked_with_plaid", "The linked account's holder name is matched to the supplier's legal name", [change("ownership_checked_with_plaid")], runs([agent("bank-ownership", "ok")])),
  check("sanctions_screened", "The supplier is re-screened against sanctions lists before anything changes", [change("sanctions_screened")], runs([agent("sanctions", "ok")])),
  check("unreadable_vendor_blocks", "When the vendor record can't be read nothing changes and AP is told", [change("unreadable_vendor_blocks")], runs([eq("output.mode", "blocked"), actionKind("netsuite.apply_bank_change", null, 0), actionKind("slack.post_change", "applied")])),
  check("slack_rate_limited", "Slack rate limiting loses the alert only; the record is kept", [change("slack_rate_limited")], all(runs([actionKind("slack.post_change", "failed"), action("asana.change_record", "applied")])), { fault: { provider: "slack", scenario: "rate_limited", evidence: "refusal" } }),
  check("invalid_input_rejected", "Untokenised bank details are rejected before any agent runs", [start("invalid_input_rejected", { ...request("invalid_input_rejected"), newBank: { accountName: "x", last4: "9012", vaultToken: "123456789" } }, { expectStatus: 400 })], runs([], 0)),
];

export default {
  workflow: "supplier-bank-change",
  providers: ["plaid", "gmail", "slack", "asana"],
  context: {
    goal: "Prove the supplier-bank-change AgentCore runtime: bank-detail change request → parallel NetSuite vendor read, Plaid identity match, sanctions screening → payment hold, Twilio Verify callback to the number on file, AP confirmation and treasury approval by two different people (Kit v2 signals with segregation of duties and deadlines), then the change is applied and the hold released; otherwise the account on file stays. Every event is hash-chained.",
    workflow: "POST /invocations {action:start} assesses, holds and calls back; {action:signal, actionId, value, userId} confirms or approves; {action:tick} applies deadlines; {action:evidence} returns the verified audit trail. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["submitter_cannot_confirm", "verifier_cannot_also_approve"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: "Bills due soon are reported as money at risk (local tests).",
    duplicate_replay: "A duplicate request returns the same run (local tests).",
    concurrency: "Signals are compare-and-swap on the run; a second signal for the same step is idempotent or 409 (Kit v2 tests).",
    ordering_and_stale_events: ["callback_deadline_rejects"],
    delayed_or_missing_events: ["callback_deadline_rejects"],
    provider_auth_and_scopes: ["unreadable_vendor_blocks"],
    rate_limit_server_error_timeout: ["slack_rate_limited"],
    accepted_effect_response_loss: "Vendor updates are idempotent PATCHes; the callback is a single claimed effect.",
    partial_effects_and_recovery: ["treasury_rejection_keeps_old_account"],
    restart_and_durability: "A waiting run survives restarts (local tests).",
    reconciliation: "Hold and bank change reconcile against the vendor record (local tests).",
    cancellation_refund_entitlements: ["two_person_rule_applies_change", "treasury_rejection_keeps_old_account"],
    data_and_privacy_boundaries: ["ownership_checked_with_plaid", "sanctions_screened"],
    cleanup_and_isolation: ["baseline"],
  },
  evidence: ["acme-ops/src/workflows/supplier-bank-change.ts", "acme-ops/src/kit/engine.ts", "acme-ops/test/supplier-bank-change.test.ts", "acme-ops/test/kit-v2.test.ts"],
};
