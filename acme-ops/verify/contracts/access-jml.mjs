import { action, agent, all, blocked, check, command, eq, noAction, restart, runs, start, startAgain } from "./lib.mjs";

const CHANNEL = "C0GENERAL01";
const APPROVER = "U_IT_LEAD";
const ORG = "org_acme";

// Every check uses its own employee so directory state never leaks between checks.
const joiner = (who, roles = ["member", "engineer"], over = {}) => ({
  type: "joiner",
  employee: { email: `${who.replaceAll("_", "-")}@acme.test`, firstName: "Sam", lastName: "Rivera", department: "Engineering" },
  organizationId: ORG,
  roles,
  managerChannel: CHANNEL,
  approvers: [APPROVER],
  ...over,
});

function faulted(id, name, provider, scenario, assertions) {
  return check(id, name, [start(id, joiner(id))], all(...assertions.map((a) => runs([a]))), { fault: { provider, scenario, evidence: "refusal" } });
}

export const checks = [
  check("baseline", "A joiner with standard roles gets an account, both roles, an IT ticket and a manager notice with no approval needed", [start("baseline", joiner("baseline"))], all(runs([eq("phase", "DONE"), eq("outcome", "ok")]), runs([action("workos.create_user", "applied")]), runs([action("workos.grant_role:member", "applied")]), runs([action("workos.grant_role:engineer", "applied")]), runs([action("asana.it_ticket", "applied")]), runs([action("slack.notify_manager", "applied")]))),
  check("privileged_role_parked", "A privileged role (finance-admin) waits for approval while standard access is granted", [start("privileged_role_parked", joiner("privileged", ["member", "finance-admin"]))], all(runs([eq("phase", "AWAITING_APPROVAL")]), runs([action("workos.grant_role:member", "applied")]), runs([action("workos.grant_role:finance-admin", "pending_approval")]))),
  check("approve_and_reconcile", "Approved privileged access is granted and read back from the directory", [start("approve_and_reconcile", joiner("approved", ["member", "finance-admin"])), command("decide", 1, { decision: "approve", userId: APPROVER }), command("reconcile", 1)], all(runs([eq("phase", "DONE")]), runs([action("workos.grant_role:finance-admin", "applied", 1, [eq("reconciled", "match")])]), runs([action("workos.create_user", "applied", 1, [eq("reconciled", "match")])]))),
  check("approve_by_stranger_refused", "Someone who is not an approver cannot grant privileged access", [start("approve_by_stranger_refused", joiner("stranger", ["member", "it-admin"])), command("decide", 1, { decision: "approve", userId: "U_RANDOM" }, 403)], all(runs([eq("phase", "AWAITING_APPROVAL")]), runs([action("workos.grant_role:it-admin", "pending_approval")]))),
  check("reject", "A rejected privileged grant is never applied", [start("reject", joiner("rejected", ["member", "security-admin"])), command("decide", 1, { decision: "reject", userId: APPROVER })], all(runs([eq("phase", "REJECTED")]), runs([action("workos.grant_role:security-admin", "rejected")]))),
  check("segregation_of_duties", "Conflicting privileged roles (finance-admin + it-admin) are held back; standard access still goes through", [start("segregation_of_duties", joiner("sod", ["member", "finance-admin", "it-admin"]))], all(runs([action("workos.grant_role:member", "applied")]), runs([noAction("workos.grant_role:finance-admin")]), runs([noAction("workos.grant_role:it-admin")]))),
  check(
    "leaver_deprovisioned",
    "A leaver's account is removed only after approval, and reconcile proves it is gone",
    [
      start("leaver_deprovisioned", joiner("leaver"), { runId: "lv-join-{{run_id}}" }),
      start("leaver_deprovisioned", { ...joiner("leaver"), type: "leaver", roles: [] }, { runId: "lv-leave-{{run_id}}" }),
      command("decide", 2, { decision: "approve", userId: APPROVER }),
      command("reconcile", 2),
    ],
    runs([eq("phase", "DONE"), action("workos.deprovision_user", "applied", 1, [eq("reconciled", "match")])]),
  ),
  check("leaver_unknown_account", "A leaver with no account produces the offboarding ticket but no directory change", [start("leaver_unknown_account", { ...joiner("ghost"), type: "leaver", roles: [] })], all(runs([eq("phase", "DONE")]), runs([noAction("workos.deprovision_user")]), runs([action("asana.it_ticket", "applied")]))),
  check(
    "mover_grants_new_role",
    "A mover gets the new role immediately; removing the old one waits for approval",
    [
      start("mover_grants_new_role", joiner("mover", ["member", "sales"]), { runId: "mv-join-{{run_id}}" }),
      start("mover_grants_new_role", { ...joiner("mover", ["member", "support"]), type: "mover", previousRoles: ["member", "sales"] }, { runId: "mv-move-{{run_id}}" }),
    ],
    runs([eq("phase", "AWAITING_APPROVAL"), action("workos.grant_role:support", "applied"), action("workos.revoke_role:sales", "pending_approval")]),
  ),
  check("duplicate_start", "A re-delivered HR event does not create a second account", [start("duplicate_start", joiner("duplicate")), startAgain("duplicate_start", joiner("duplicate"))], runs([action("workos.create_user", "applied", 1, [eq("attempts", 1)])])),
  check("concurrent_start", "Four more simultaneous deliveries of one HR event create one account", [start("concurrent_start", joiner("concurrent")), startAgain("concurrent_start", joiner("concurrent"), 1, 4)], runs([action("workos.create_user", "applied", 1, [eq("attempts", 1)])])),
  check("invalid_input_rejected", "A joiner without roles is rejected before anything runs", [start("invalid_input_rejected", joiner("invalid", []), { expectStatus: 400 })], runs([], 0)),
  faulted("workos_auth_failure", "If the directory can't be read, no access change is attempted", "workos", "auth_failure", [agent("directory-lookup", "failed"), { select: "actions[*]", count: 0, required: true }]),
  faulted("asana_rate_limited", "An Asana outage fails only the IT ticket; directory access is still granted", "asana", "rate_limited", [action("asana.it_ticket", "failed"), action("workos.grant_role:member", "applied"), eq("outcome", "partial")]),
  faulted("slack_auth_failure", "A Slack failure loses the manager notice only", "slack", "auth_failure", [action("slack.notify_manager", "failed"), action("workos.create_user", "applied")]),
  check("restart_while_parked", "A privileged grant parked for approval survives a runtime restart and is applied when approved afterwards", [start("restart_while_parked", joiner("restart", ["member", "billing-admin"])), restart, command("decide", 1, { decision: "approve", userId: APPROVER })], runs([eq("phase", "DONE"), action("workos.grant_role:billing-admin", "applied")])),
  blocked("app_seat_provisioning", "GitHub org, Google Workspace and Slack seats are provisioned and removed with the directory account", "setup_missing", "The FetchSandbox GitHub twin has no org-membership endpoints and there are no Google Workspace Admin or Slack SCIM twins; these seats are listed as manual items on the IT ticket.", ["acme-ops/src/workflows/access-jml.ts asana.it_ticket checklist", "FetchSandbox github operations: repos/issues/pulls only"]),
  blocked("mover_old_role_removed", "Approving a mover's revoke removes the old membership", "setup_missing", "The WorkOS twin's GET /user_management/organization_memberships?user_id= returns a generic object, so existing memberships can't be found and revoke fails closed.", ["acme-ops/src/workflows/access-jml.ts workos.revoke_role", "WorkOS twin list memberships response is not {data:[...]}"]),
];

export default {
  workflow: "access-jml",
  providers: ["workos", "asana", "slack"],
  context: {
    goal: "Prove the access-jml AgentCore runtime: HR joiner/mover/leaver event → directory account and roles in WorkOS, IT ticket in Asana, manager notice in Slack; privileged grants, revokes and deprovisioning gated; reconcile proves access.",
    workflow: "POST /invocations {action:start} reads the directory and policy, applies standard access and parks privileged changes; {action:decide} applies them; {action:reconcile} re-reads WorkOS. GET /verify/runs/{run}/cases/{case}/runs reads saved run state.",
    entry_points: ["POST /invocations"],
    state_store: "Run records exposed read-only at GET /verify/runs/{run_id}/cases/{check_id}/runs → {runs:[...]}, bearer-protected.",
  },
  checks,
  coverage: {
    baseline: ["baseline"],
    identity_and_access: ["approve_by_stranger_refused", "privileged_role_parked", "segregation_of_duties"],
    schema_and_value_boundaries: ["invalid_input_rejected"],
    amount_currency_quantity: "No amounts are involved.",
    duplicate_replay: ["duplicate_start"],
    concurrency: ["concurrent_start"],
    ordering_and_stale_events: ["mover_grants_new_role", "leaver_unknown_account"],
    delayed_or_missing_events: "HR events arrive synchronously from the control plane.",
    provider_auth_and_scopes: ["workos_auth_failure", "slack_auth_failure"],
    rate_limit_server_error_timeout: ["asana_rate_limited"],
    accepted_effect_response_loss: "Covered by side-effect claims and write-time re-check of the account in local design.",
    partial_effects_and_recovery: ["asana_rate_limited"],
    restart_and_durability: ["restart_while_parked"],
    reconciliation: ["approve_and_reconcile", "leaver_deprovisioned"],
    cancellation_refund_entitlements: ["reject", "leaver_deprovisioned", "mover_old_role_removed"],
    data_and_privacy_boundaries: ["app_seat_provisioning"],
    cleanup_and_isolation: ["baseline", "concurrent_start"],
  },
  evidence: ["acme-ops/src/workflows/access-jml.ts", "acme-ops/src/kit/engine.ts", "acme-ops/src/kit/server.ts", "acme-ops/src/providers/work.ts WorkOSClient, AsanaClient"],
};
