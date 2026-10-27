# Joiner, mover, leaver access

## Business need

IT needs to grant the correct employee access and remove it when employment changes, while keeping privileged changes under human control.

Turn an HR joiner/mover/leaver event into directory changes: create the account and standard roles, open the IT ticket and tell the manager. Privileged roles, role removals and deprovisioning wait for approval; reconcile proves a leaver's account is gone.

Demo organization: **Acme Corporation**. Department: **IT**. Owning team: **it-identity**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "type": "joiner",
    "employee": {
      "email": "baseline@acme.test",
      "firstName": "Sam",
      "lastName": "Rivera",
      "department": "Engineering"
    },
    "organizationId": "org_acme",
    "roles": [
      "member",
      "engineer"
    ],
    "managerChannel": "C0GENERAL01",
    "approvers": [
      "U_IT_LEAD"
    ]
  },
  "requestedBy": {
    "userId": "U_FETCHSANDBOX"
  },
  "labels": {
    "fs_run": "{{run_id}}",
    "fs_case": "baseline"
  }
}
```

The customer/operator result is determined by the actions below. A `gmail.draft_*` action creates a draft; it does not prove that email was sent or received. A public ticket comment does not establish live inbox delivery.

## Input contract

These top-level fields come from the runtime schema. Nested shape and conditional rules are demonstrated in the example and enforced by the linked source.

| Field | Required | Type / allowed values |
|---|---|---|
| `type` | yes | string / joiner, mover, leaver |
| `employee` | yes | object |
| `organizationId` | yes | string |
| `roles` | yes | array |
| `previousRoles` | yes | array |
| `managerChannel` | yes | string |
| `itWorkspace` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `directory-lookup` | workos |
| `policy-check` | No direct provider requirement; uses input or prior agent results |

**2 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `workos.create_user` | workos | **auto** | Create the directory account for a joiner |
| `workos.grant_role` | workos | **auto** | Grant a standard role; privileged roles need approval |
| `workos.revoke_role` | workos | **approval** | Remove a role a mover no longer needs |
| `workos.deprovision_user` | workos | **approval** | Delete a leaver's account and every membership |
| `asana.it_ticket` | asana | **auto** | Open the IT checklist ticket (laptop, manual app seats) |
| `slack.notify_manager` | slack | **auto** | Tell the manager what changed and what awaits approval |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| workos | `WORKOS_API_KEY` |  |
| asana | `ASANA_API_KEY` (personal access token) |  |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=access-jml STATE_FILE=.state/access-jml.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs access-jml
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A joiner with standard roles gets an account, both roles, an IT ticket and a manager notice with no approval needed | Executable declaration; result comes from a receipt |
| `privileged_role_parked` | A privileged role (finance-admin) waits for approval while standard access is granted | Executable declaration; result comes from a receipt |
| `approve_and_reconcile` | Approved privileged access is granted and read back from the directory | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | Someone who is not an approver cannot grant privileged access | Executable declaration; result comes from a receipt |
| `reject` | A rejected privileged grant is never applied | Executable declaration; result comes from a receipt |
| `segregation_of_duties` | Conflicting privileged roles (finance-admin + it-admin) are held back; standard access still goes through | Executable declaration; result comes from a receipt |
| `leaver_deprovisioned` | A leaver's account is removed only after approval, and reconcile proves it is gone | Executable declaration; result comes from a receipt |
| `leaver_unknown_account` | A leaver with no account produces the offboarding ticket but no directory change | Executable declaration; result comes from a receipt |
| `mover_grants_new_role` | A mover gets the new role immediately; removing the old one waits for approval | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-delivered HR event does not create a second account | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four more simultaneous deliveries of one HR event create one account | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A joiner without roles is rejected before anything runs | Executable declaration; result comes from a receipt |
| `workos_auth_failure` | If the directory can't be read, no access change is attempted | Executable declaration; result comes from a receipt |
| `asana_rate_limited` | An Asana outage fails only the IT ticket; directory access is still granted | Executable declaration; result comes from a receipt |
| `slack_auth_failure` | A Slack failure loses the manager notice only | Executable declaration; result comes from a receipt |
| `restart_while_parked` | A privileged grant parked for approval survives a runtime restart and is applied when approved afterwards | Executable declaration; result comes from a receipt |
| `app_seat_provisioning` | GitHub org, Google Workspace and Slack seats are provisioned and removed with the directory account | The FetchSandbox GitHub twin has no org-membership endpoints and there are no Google Workspace Admin or Slack SCIM twins; these seats are listed as manual items on the IT ticket. |
| `mover_old_role_removed` | Approving a mover's revoke removes the old membership | The WorkOS twin's GET /user_management/organization_memberships?user_id= returns a generic object, so existing memberships can't be found and revoke fails closed. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-access-jml-1.0.0-7e9260e`, verdict **inconclusive**, and statuses: **16 held**, **2 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/84e946ba3d?flow=vr_8d2160fd4bd847979c0d3ead96024d41) · [Saved result](../../acme-ops/verify/receipts/access-jml.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/access-jml.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/access-jml.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
