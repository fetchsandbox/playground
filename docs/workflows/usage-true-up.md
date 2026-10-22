# Usage true-up (committed use)

## Business need

Billing must invoice every committed-use customer for what they used beyond their contract, exactly once, with notice and a chance to dispute, and never guess when a contract is incomplete.

Compare each committed-use customer's metered usage with its contract, draft an overage invoice once per true-up (approval over the limit), notify the billing contact, and finalize after a 7-day notice window unless the account owner holds it; incomplete contracts or unreadable usage are reported, never guessed.

Demo organization: **Acme Corporation**. Department: **RevOps**. Owning team: **billing-ops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "trueUpId": "TU-baseline",
    "meterId": "mtr_SEED",
    "periodStart": "2026-10-21",
    "periodEnd": "2026-10-23",
    "customers": [
      "cus_SEED_baseline"
    ],
    "revopsChannel": "C0REVOPS001",
    "owners": {
      "cus_SEED_baseline": "U_AE"
    },
    "billingLeads": [
      "U_BILLING_LEAD"
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
| `trueUpId` | yes | string |
| `meterId` | yes | string |
| `periodStart` | yes | string |
| `periodEnd` | yes | string |
| `customers` | yes | array |
| `revopsChannel` | yes | string |
| `owners` | yes | object |
| `billingLeads` | yes | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `contracts` | stripe |
| `usage` | stripe |
| `true-up` | No direct provider requirement; uses input or prior agent results |

**3 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `stripe.draft_overage` | stripe | **auto** | Draft overage invoice, once per true-up; approval over 25,000 |
| `gmail.notice` | gmail | **auto** | Breakdown to the billing contact (draft) |
| `stripe.issue` | stripe | **auto** | Signal: finalize and send after the notice window unless held |
| `slack.post_true_up` | slack | **auto** | Summary with contracts that couldn't be trued up |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=usage-true-up STATE_FILE=.state/usage-true-up.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs usage-true-up
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A request starts one recorded run (provider-independent, so every later check is measured) | Executable declaration; result comes from a receipt |
| `baseline_effects` | A true-up reads contracts and usage and posts a summary | Executable declaration; result comes from a receipt |
| `usage_read_from_meter` | Usage for the period is read from the billing meter | Executable declaration; result comes from a receipt |
| `overage_drafted_once` | 300 units over a 1,000-unit commitment become one draft invoice and a notice | Executable declaration; result comes from a receipt |
| `under_commitment_not_billed` | Usage under the commitment bills nothing | Executable declaration; result comes from a receipt |
| `missing_contract_reported` | A subscription without a commitment is reported, never guessed | Executable declaration; result comes from a receipt |
| `owner_holds_invoice` | The account owner's hold during the notice window keeps the invoice in draft | Executable declaration; result comes from a receipt |
| `issued_after_notice` | With no hold, the invoice is finalized and sent after 7 days (needs clock control) | Executable declaration; result comes from a receipt |
| `large_overage_needs_approval` | An overage over 25,000 waits for approval before any invoice exists | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A malformed meter id is rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-usage-true-up-1.0.0-06c2f09`, verdict **failing**, and statuses: **5 held**, **1 unmeasured**, **4 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/aa5bb1a765?flow=vr_dcbd9eb9423c41f18d954ee4153c447a) · [Saved result](../../acme-ops/verify/receipts/usage-true-up.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/usage-true-up.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/usage-true-up.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
