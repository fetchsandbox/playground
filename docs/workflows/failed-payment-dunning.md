# Failed-payment dunning

## Business need

Finance needs to recover failed subscription payments with a predictable, never-repeating reminder ladder, and to cancel only after a person agrees.

Walk a failed invoice up a dunning ladder from Stripe's signed invoice.payment_failed and a daily age sweep: card-update notice, reminder with one backup-card retry, final notice, then subscription cancellation with approval. Steps never repeat or go back and a paid invoice stops the ladder.

Demo organization: **Acme Corporation**. Department: **Finance**. Owning team: **billing-ops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "stage": "sweep",
    "customers": [
      "dun-baseline@billing.example.com"
    ],
    "financeChannel": "C0BILLING01",
    "approvers": [
      "U_CONTROLLER"
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

### Input variant 1

| Field | Required | Type / allowed values |
|---|---|---|
| `stage` | yes | string / payment_failed |
| `invoiceId` | yes | string |
| `eventId` | no/default | string |
| `financeChannel` | yes | string |
| `approvers` | no/default | array |

### Input variant 2

| Field | Required | Type / allowed values |
|---|---|---|
| `stage` | yes | string / sweep |
| `customers` | yes | array |
| `financeChannel` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `invoice-check` | stripe |
| `dunning-plan` | No direct provider requirement; uses input or prior agent results |

**2 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `stripe.retry_backup` | stripe | **auto** | Retry the invoice once with the customer's other saved card on the second failure |
| `gmail.draft_notice` | gmail | **auto** | Draft (not send) the card-update notice, reminder or final notice |
| `stripe.cancel_subscription` | stripe | **approval** | Cancel the subscription after the cancel threshold; always approved by a person |
| `stripe.record_step` | stripe | **auto** | Record the step on the customer so the ladder never repeats or goes back |
| `slack.escalate` | slack | **auto** | Tell finance about high-value failures, cancellations and unreadable invoices |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=failed-payment-dunning STATE_FILE=.state/failed-payment-dunning.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs failed-payment-dunning
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | The daily sweep reads the customer's open invoices and finishes | Executable declaration; result comes from a receipt |
| `first_failure_card_update_notice` | After the first failed collection the customer gets a card-update notice draft and the step is recorded | Executable declaration; result comes from a receipt |
| `second_failure_tries_backup_card` | After the second failure the customer's other saved card is tried once, and a reminder goes out if it declines | Executable declaration; result comes from a receipt |
| `final_notice_after_14_days` | An invoice unpaid for 14 days gets the final notice from the daily sweep | Executable declaration; result comes from a receipt |
| `cancellation_needs_approval` | After 21 days the sweep proposes cancelling the subscription, and it waits for the controller | Executable declaration; result comes from a receipt |
| `repeated_failure_no_second_notice` | A second delivery of the same failure (a new trigger) finds the step taken and sends nothing more | Executable declaration; result comes from a receipt |
| `paid_invoice_contacts_nobody` | A failure event for an invoice that is paid by now contacts nobody | Executable declaration; result comes from a receipt |
| `unknown_invoice_contacts_nobody` | An invoice Stripe doesn't know contacts nobody and alerts finance | Executable declaration; result comes from a receipt |
| `stripe_auth_failure` | Without Stripe nobody is contacted and finance is alerted | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A malformed invoice id is rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-failed-payment-dunning-1.0.0-4ac41d8`, verdict **failing**, and statuses: **5 held**, **2 unmeasured**, **3 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/198897286c?flow=vr_243352f82fcf4575922b792da8a81865) · [Saved result](../../acme-ops/verify/receipts/failed-payment-dunning.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/failed-payment-dunning.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/failed-payment-dunning.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
