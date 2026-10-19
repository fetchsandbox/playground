# Order status and expedite

## Business need

Customer Experience needs to answer delivery questions from billing and fulfillment records, and obtain approval before changing a promised date.

Answer "where is my order" from the Stripe invoice and the warehouse's Asana fulfillment task: schedule unscheduled orders, draft the reply, alert the owner on late orders. Changing the promise date waits for approval.

Demo organization: **Acme Corporation**. Department: **Customer Experience**. Owning team: **cx-service**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "customer": {
      "email": "alice@acmecorp.com",
      "name": "Alice Johnson"
    },
    "invoiceId": "in_3QaT2bVwXy5zA6Bc7D",
    "ownerChannel": "C0BILLING01",
    "approvers": [
      "U_CX_LEAD"
    ],
    "promisedOn": "2026-12-15"
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
| `customer` | yes | object |
| `invoiceId` | yes | string |
| `question` | yes | string |
| `promisedOn` | no/default | string |
| `revisedPromiseOn` | no/default | string |
| `ownerChannel` | yes | string |
| `warehouseWorkspace` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `order-lookup` | stripe |
| `fulfillment` | stripe, asana |
| `account-owner` | hubspot |
| `status-composer` | No direct provider requirement; uses input or prior agent results |

**4 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `asana.schedule_fulfillment` | asana | **auto** | Create the warehouse fulfillment task for an unscheduled order |
| `stripe.link_fulfillment` | stripe | **auto** | Record the fulfillment task on the invoice metadata |
| `gmail.draft_status_reply` | gmail | **auto** | Create (not send) the status reply draft |
| `slack.alert_late_order` | slack | **auto** | Alert the owner channel about a late order |
| `asana.revise_promise_date` | asana | **approval** | Move the promise date on the fulfillment task |
| `gmail.draft_revised_date` | gmail | **approval** | Create (not send) the revised-date draft |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=order-status STATE_FILE=.state/order-status.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs order-status
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | An unscheduled order gets a warehouse fulfillment task, linked on the invoice, and a drafted status reply | Executable declaration; result comes from a receipt |
| `on_time_order_reply_only` | An order on track gets a reply draft and no alert | Executable declaration; result comes from a receipt |
| `late_order_detected` | An order past its promise date alerts the owner and parks a new promise date for approval | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | A non-approver cannot move a promise date | Executable declaration; result comes from a receipt |
| `reject` | Rejecting keeps the original promise date | Executable declaration; result comes from a receipt |
| `restart_approve_and_reconcile` | A late order parked for approval survives a runtime restart; approval moves the promise date, and Asana reads back the new date | Executable declaration; result comes from a receipt |
| `after_new_date_on_time` | After the date moved, the same order reads as on time with no alert | Executable declaration; result comes from a receipt |
| `someone_elses_order_refused` | Asking about another customer's invoice reveals nothing and drafts nothing | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-delivered question drafts one reply | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four more simultaneous deliveries draft one reply | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A malformed promise date is rejected before any agent runs | Executable declaration; result comes from a receipt |
| `asana_rate_limited` | Without the warehouse task the reply still goes out as 'checking'; nothing is rescheduled | Executable declaration; result comes from a receipt |
| `stripe_auth_failure` | Without Stripe the order can't be verified: nothing is drafted or changed | Executable declaration; result comes from a receipt |
| `gmail_rate_limited` | Gmail rate limiting fails the reply draft only | Executable declaration; result comes from a receipt |
| `carrier_tracking` | Shipped orders include the carrier's live tracking status | No carrier twin (UPS/FedEx/EasyPost/Shippo) in FetchSandbox; 'shipped' comes from the completed warehouse task only. |
| `erp_order_lines` | Order lines, backorders and lead times come from the ERP | No ERP twin (SAP/Oracle/NetSuite); ACME's order is its Stripe invoice and the promise date its Asana task. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-order-status-1.0.0-9e32d92`, verdict **inconclusive**, and statuses: **14 held**, **2 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/bff7380427?flow=vr_be5a26e56b3848efb4526afebc5392a5) · [Saved result](../../acme-ops/verify/receipts/order-status.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/order-status.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/order-status.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
