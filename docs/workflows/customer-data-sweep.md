# Customer data-quality sweep

## Business need

RevOps needs a nightly data-quality sweep over thousands of billing records that never acts on a partial read and never rewrites thousands of records because of one bad rule.

Page through every Stripe customer of a segment, refuse an incomplete scan (a cursor that doesn't advance or fewer records than expected), flag missing tax country and duplicate emails on the customer, with a per-run limit on automatic writes; summary to Asana and Slack.

Demo organization: **Acme Corporation**. Department: **RevOps**. Owning team: **revops-data**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "segment": "baseline",
    "expectedMin": 3,
    "revopsChannel": "C0REVOPS01",
    "approvers": [
      "U_REVOPS_LEAD"
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
| `segment` | yes | string |
| `expectedMin` | yes | integer |
| `autoFlagMax` | yes | integer |
| `revopsChannel` | yes | string |
| `revopsWorkspace` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `customer-scan` | stripe |
| `sweep-decision` | No direct provider requirement; uses input or prior agent results |

**2 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `stripe.flag_customer` | stripe | **auto** | Flag a customer's data-quality issue in metadata; approval past the per-run limit |
| `asana.sweep_record` | asana | **auto** | Sweep record for RevOps |
| `slack.post_sweep` | slack | **auto** | Sweep result in the RevOps channel |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=customer-data-sweep STATE_FILE=.state/customer-data-sweep.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs customer-data-sweep
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A request starts one recorded run (provider-independent, so every later check is measured) | Executable declaration; result comes from a receipt |
| `baseline_effects` | A small segment is scanned and its customer without a country is flagged; the sweep is recorded and posted | Executable declaration; result comes from a receipt |
| `full_scan_250` | A 250-customer segment is read completely across three pages and all 25 customers without a country are flagged | Executable declaration; result comes from a receipt |
| `flag_limit_needs_approval` | Past the run's automatic limit (5), flags wait for approval | Executable declaration; result comes from a receipt |
| `rerun_flags_nothing` | A second sweep of the same segment finds everything flagged already and writes nothing | Executable declaration; result comes from a receipt |
| `incomplete_scan_refused` | When the scan finds fewer customers than the billing system expects, nothing is flagged and RevOps is alerted | Executable declaration; result comes from a receipt |
| `stripe_rate_limited` | A rate-limited customer list fails the scan closed: nothing is flagged | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A segment name with spaces is rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-customer-data-sweep-1.0.0-befeb35`, verdict **failing**, and statuses: **4 held**, **4 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/5e8db1a7ef?flow=vr_ea8d1d081bf341a7b716cd7513c668a2) · [Saved result](../../acme-ops/verify/receipts/customer-data-sweep.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/customer-data-sweep.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/customer-data-sweep.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
