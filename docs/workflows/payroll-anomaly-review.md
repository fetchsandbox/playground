# Payroll anomaly review

## Business need

Payroll must catch payments to people who have left and unexplained pay jumps before money moves, without making everyone else wait for their pay.

Compare each employee's gross pay on an upcoming Gusto payroll with their recent median, flag pay after termination, large increases and oversized first payrolls; submit clean payrolls at once, otherwise wait for a reviewer who didn't prepare it and, without approval before the deadline, exclude the flagged employees and pay everyone else on time.

Demo organization: **Acme Corporation**. Department: **People**. Owning team: **payroll-ops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "reviewId": "PAYREV-baseline",
    "payrollId": "pr_baseline",
    "preparer": "U_PREP",
    "reviewers": [
      "U_PREP",
      "U_CONTROLLER"
    ],
    "payrollChannel": "C0PAYROLL01"
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
| `reviewId` | yes | string |
| `payrollId` | yes | string |
| `preparer` | yes | string |
| `reviewers` | yes | array |
| `payrollChannel` | yes | string |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `payroll` | gusto |
| `employees` | gusto |
| `anomalies` | No direct provider requirement; uses input or prior agent results |

**3 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `slack.post_anomalies` | slack | **auto** | Anomalies, who may approve and the decision deadline |
| `payroll.review` | gusto | **auto** | Signal: a reviewer who didn't prepare the payroll approves paying as is |
| `gusto.exclude_flagged` | gusto | **auto** | Without approval, exclude the flagged employees (prepare, then version-guarded update) |
| `gusto.submit` | gusto | **auto** | Submit the payroll so everyone else is paid on time |
| `slack.post_blocked` | slack | **auto** | Gusto unreadable: nothing submitted |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=payroll-anomaly-review STATE_FILE=.state/payroll-anomaly-review.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs payroll-anomaly-review
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A request starts one recorded run (provider-independent, so every later check is measured) | Executable declaration; result comes from a receipt |
| `baseline_effects` | A payroll review reads the payroll, its history and employees | Executable declaration; result comes from a receipt |
| `clean_payroll_submitted` | A payroll without anomalies is submitted at once | Executable declaration; result comes from a receipt |
| `anomalies_flagged` | Pay after termination, a large raise and an oversized first payroll are flagged | Executable declaration; result comes from a receipt |
| `preparer_cannot_approve` | The person who prepared the payroll can't approve its anomalies | Executable declaration; result comes from a receipt |
| `deadline_holds_flagged_pays_rest` | Without approval before the deadline the flagged are excluded and the rest is paid (needs clock control) | Executable declaration; result comes from a receipt |
| `gusto_unavailable_never_submits` | When Gusto can't be read nothing is submitted and payroll-ops is told | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A malformed review id is rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-payroll-anomaly-review-1.0.0-befeb35`, verdict **failing**, and statuses: **3 held**, **1 unmeasured**, **4 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/460b43d7b8?flow=vr_42e0d5627b754acda8a2603350d1d9bc) · [Saved result](../../acme-ops/verify/receipts/payroll-anomaly-review.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/payroll-anomaly-review.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/payroll-anomaly-review.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
