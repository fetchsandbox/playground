# Invoice three-way match

## Business need

Accounts Payable needs every supplier bill matched to what was ordered and received before it is paid, with people spending time only on real exceptions and duplicates never paid twice.

Match every pending NetSuite vendor bill against its purchase order and receipts: clean matches are approved automatically, tolerance variances by an AP approver who didn't enter the bill, exceptions and suspected duplicates are held for a buyer; checkpointed per bill.

Demo organization: **Acme Corporation**. Department: **Finance**. Owning team: **accounts-payable**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "batchId": "AP-baseline",
    "billIds": [
      "11",
      "12",
      "13",
      "14"
    ],
    "apChannel": "C0FINANCE01",
    "approvers": [
      "U_AP_LEAD",
      "U_AP_CLERK"
    ],
    "buyers": [
      "U_BUYER"
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
| `batchId` | yes | string |
| `billIds` | no/default | array |
| `apChannel` | yes | string |
| `apWorkspace` | yes | string |
| `approvers` | no/default | array |
| `buyers` | yes | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `match-engine` | netsuite |

**1 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `netsuite.approve_bill` | netsuite | **auto** | Approve a clean match automatically; tolerance variances by an AP approver who didn't enter the bill |
| `netsuite.hold_bill` | netsuite | **auto** | Payment hold on exceptions and suspected duplicates |
| `asana.exception` | asana | **auto** | Exception task with the reasons |
| `netsuite.buyer_release` | netsuite | **auto** | Signal: a buyer releases an exception as billed |
| `slack.post_batch` | slack | **auto** | Batch summary |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=invoice-three-way-match STATE_FILE=.state/invoice-three-way-match.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs invoice-three-way-match
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | An AP batch posts its outcome to the AP channel | Executable declaration; result comes from a receipt |
| `bills_read_from_erp` | Pending bills, their purchase orders and receipts are read from the ERP | Executable declaration; result comes from a receipt |
| `clean_match_auto_approved` | A bill that matches its PO and receipts within the limit is approved without a person | Executable declaration; result comes from a receipt |
| `variance_needs_ap_approval` | A price variance within tolerance waits for an AP approver | Executable declaration; result comes from a receipt |
| `entering_clerk_cannot_approve` | The clerk who entered a bill can't approve its variance | Executable declaration; result comes from a receipt |
| `over_billed_held` | A bill for more than was received is put on payment hold and routed to a buyer | Executable declaration; result comes from a receipt |
| `duplicate_never_approved` | Bills sharing a vendor invoice number are held, never approved | Executable declaration; result comes from a receipt |
| `erp_unreadable_approves_nothing` | When bills can't be read, nothing is approved and AP is told | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limiting loses the summary only | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A malformed batch id is rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-invoice-three-way-match-1.0.0-4ac41d8`, verdict **failing**, and statuses: **4 held**, **1 unmeasured**, **5 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/cec6cff8bf?flow=vr_fbd12df7d3c54163a3711aaf0af39176) · [Saved result](../../acme-ops/verify/receipts/invoice-three-way-match.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/invoice-three-way-match.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/invoice-three-way-match.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
