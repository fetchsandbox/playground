# Change management gate

## Business need

Platform Engineering needs every production change checked against incidents, monitors and freezes, approved by someone other than its author when required, and rolled back automatically when it degrades the service.

Gate a production deploy on the change (merged, green, reviewed by someone else), live operations (incidents, alerting monitors) and freezes; standard changes deploy, normal ones need a CAB approver who isn't the author, emergencies are reviewed after. A degraded watch window rolls back automatically.

Demo organization: **Acme Corporation**. Department: **Engineering**. Owning team: **platform-ops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "changeId": "CHG-baseline",
    "repo": "acme/checkout",
    "pullRequest": 1,
    "service": {
      "name": "checkout",
      "pagerdutyServiceId": "PSVC123",
      "monitorIds": [],
      "errorRateQuery": "sum:checkout.errors{*}.as_rate()"
    },
    "type": "standard",
    "opsChannel": "C0PLATFORM1",
    "approvers": [
      "U_CAB_1",
      "U_CAB_2"
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
| `changeId` | yes | string |
| `repo` | yes | string |
| `pullRequest` | yes | integer |
| `service` | yes | object |
| `environment` | yes | string |
| `type` | yes | string / standard, normal, emergency |
| `freezes` | yes | array |
| `opsChannel` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `change-check` | github |
| `ops-check` | pagerduty, datadog |
| `gate` | No direct provider requirement; uses input or prior agent results |

**3 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `cab.approve` | github | **auto** | Signal: a CAB approver who isn't the author approves a normal change |
| `github.deploy` | github | **auto** | GitHub deployment of the merged commit; compensated by a rollback deployment |
| `datadog.watch` | datadog | **auto** | Watch window: error rate and monitors; degradation rolls back |
| `github.mark_success` | github | **auto** | Deployment status success after a healthy watch |
| `cab.post_review` | github | **auto** | Signal: CAB reviews an emergency change within 24 h |
| `slack.post_change` | slack | **auto** | Start, block and outcome posts |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=change-management-gate STATE_FILE=.state/change-management-gate.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs change-management-gate
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A change request is checked and its outcome posted to operations | Executable declaration; result comes from a receipt |
| `change_facts_read` | The pull request, its reviews and check runs are read from GitHub | Executable declaration; result comes from a receipt |
| `ops_facts_read` | Open incidents (PagerDuty) and monitor states (Datadog) are read | Executable declaration; result comes from a receipt |
| `standard_change_deploys` | A merged, reviewed, green standard change with no incident deploys automatically | Executable declaration; result comes from a receipt |
| `normal_change_needs_cab` | A normal change waits for a CAB approver | Executable declaration; result comes from a receipt |
| `author_cannot_approve` | The change's author can't approve it | Executable declaration; result comes from a receipt |
| `healthy_watch_marks_success` | After a healthy 15-minute watch the deployment is marked successful (needs clock control) | Executable declaration; result comes from a receipt |
| `degraded_watch_rolls_back` | A degraded watch window rolls the deployment back (needs clock control and a scriptable error rate) | Executable declaration; result comes from a receipt |
| `freeze_blocks` | A change inside a freeze window is blocked | Executable declaration; result comes from a receipt |
| `github_unreadable_blocks` | When the pull request can't be read nothing deploys | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A malformed repository is rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-change-management-gate-1.0.0-06c2f09`, verdict **failing**, and statuses: **5 held**, **1 unmeasured**, **5 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/3de250868c?flow=vr_55bd8d33c1bb4538a9936780cce0d10a) · [Saved result](../../acme-ops/verify/receipts/change-management-gate.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/change-management-gate.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/change-management-gate.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
