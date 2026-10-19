# Product cancellation and refund

## Business need

Customer Experience needs to acknowledge cancellation requests, evaluate subscription terms, obtain exceptions where required, and let the correct customer choose an eligible refund method.

Cancellation requests by email, phone or Slack: open or annotate the Zendesk ticket, acknowledge the customer, research the subscription against the cancellation and refund policy, cancel when the policy allows (exceptions wait for approval), offer the refund methods the policy allows and, when the customer picks one on the ticket, refund to the original payment (Stripe), as store credit (Stripe balance) or as a gift card (Square), then confirm on the ticket.

Demo organization: **Acme Corporation**. Department: **Customer Experience**. Owning team: **cx-retention**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-req-{{run_id}}",
  "input": {
    "stage": "request",
    "channel": "email",
    "customer": {
      "email": "cxl-baseline@cancel.test",
      "name": "Robin Example"
    },
    "ticketId": 2001,
    "message": "Please cancel my subscription, we no longer need it.",
    "opsChannel": "C0BILLING01",
    "giftCardLocationId": "LKZQE8ZN3GSKR",
    "approvers": [
      "U_CX_LEAD"
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
| `stage` | yes | string / request |
| `channel` | yes | string / email, phone, slack |
| `ticketId` | no/default | integer |
| `subscriptionId` | no/default | string |
| `productId` | no/default | string |
| `message` | yes | string |
| `customer` | yes | object |
| `opsChannel` | yes | string |
| `giftCardLocationId` | no/default | string |
| `opsThreadTs` | no/default | string |
| `approvers` | no/default | array |

### Input variant 2

| Field | Required | Type / allowed values |
|---|---|---|
| `stage` | yes | string / refund_choice |
| `ticketId` | yes | integer |
| `choice` | no/default | string / original_payment, store_credit, gift_card |
| `customer` | yes | object |
| `opsChannel` | yes | string |
| `giftCardLocationId` | no/default | string |
| `opsThreadTs` | no/default | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `ticket-context` | zendesk |
| `policy-research` | stripe |
| `gift-card-desk` | square |
| `case-decision` | No direct provider requirement; uses input or prior agent results |

**4 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `zendesk.create_ticket` | zendesk | **auto** | Open the ticket for a request that arrived without one |
| `zendesk.acknowledge` | zendesk | **auto** | Public reply (emailed by Zendesk) explaining the cancellation process |
| `zendesk.policy_note` | zendesk | **auto** | Internal note with the policy research and the decision |
| `stripe.cancel_subscription` | stripe | **auto** | Cancel the subscription when the policy allows it; recording the refund offer on it |
| `stripe.cancel_subscription_exception` | stripe | **approval** | Cancel outside the policy (commitment term, non-cancellable product) |
| `zendesk.refund_offer` | zendesk | **auto** | Public reply confirming the cancellation and asking the customer to pick a refund method (gated like the cancellation) |
| `zendesk.cancellation_confirmed` | zendesk | **auto** | Public reply confirming a cancellation with no refund due; solves the ticket (gated like the cancellation) |
| `slack.post_case` | slack | **auto** | Case feed in the ops channel, including exceptions waiting for approval |
| `zendesk.clarify_choice` | zendesk | **auto** | Ask the customer again when the reply names no offered refund method |
| `stripe.refund_original_payment` | stripe | **auto** | Refund to the original payment method; approval above the auto-refund limit |
| `stripe.issue_store_credit` | stripe | **auto** | Credit the customer's Stripe balance; approval above the auto-refund limit |
| `square.issue_gift_card` | square | **auto** | Create and activate a Square digital gift card; approval above the auto-refund limit |
| `zendesk.refund_confirmation` | zendesk | **auto** | Public reply confirming the refund; solves the ticket (gated like the refund) |
| `zendesk.gift_card_number` | zendesk | **auto** | Public reply with the gift card number (gift card refunds only) |
| `slack.post_refund` | slack | **auto** | Refund feed in the ops channel |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=product-cancellation STATE_FILE=.state/product-cancellation.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs product-cancellation
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | An in-policy email request is acknowledged, researched, cancelled and answered with a refund offer on the ticket | Executable declaration; result comes from a receipt |
| `store_credit_end_to_end` | The customer's store-credit choice credits their Stripe balance once and confirms on the ticket | Executable declaration; result comes from a receipt |
| `original_payment_end_to_end` | The original-payment choice refunds the payment intent in Stripe, and reconcile reads the refund back | Executable declaration; result comes from a receipt |
| `gift_card_end_to_end` | The gift-card choice creates and activates a Square gift card and sends its number on the ticket | Executable declaration; result comes from a receipt |
| `second_refund_refused` | A second refund choice on the same cancellation pays nothing | Executable declaration; result comes from a receipt |
| `method_not_offered_clarified` | Choosing a refund method the product's terms don't allow asks the customer again and refunds nothing | Executable declaration; result comes from a receipt |
| `contract_exception_parked` | A cancellation inside a contract commitment is acknowledged and parked for approval; nothing is cancelled | Executable declaration; result comes from a receipt |
| `exception_approved` | The CX lead's approval cancels the contract subscription and sends the offer | Executable declaration; result comes from a receipt |
| `exception_rejected` | A rejected exception cancels nothing and tells the customer nothing automatically | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | Someone who is not an approver cannot approve an exception | Executable declaration; result comes from a receipt |
| `no_refund_due` | A non-refundable product is cancelled and confirmed with no refund offer; the ticket is solved | Executable declaration; result comes from a receipt |
| `large_refund_needs_approval` | A refund above the auto-refund limit waits for approval and is issued once approved | Executable declaration; result comes from a receipt |
| `unknown_customer_not_cancelled` | A request from an address with no Stripe customer cancels nothing and is routed to a person | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-delivered request cancels once | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four simultaneous deliveries of one request cancel once | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A request with a malformed subscription id is rejected before any agent runs | Executable declaration; result comes from a receipt |
| `stripe_auth_failure` | Without Stripe nothing is cancelled; the customer is still acknowledged and a person is alerted | Executable declaration; result comes from a receipt |
| `zendesk_rate_limited` | Zendesk rate limiting fails the ticket updates only; the in-policy cancellation still happens | Executable declaration; result comes from a receipt |
| `square_auth_failure` | With the gift card system down, gift cards are not offered; the cancellation and offer go ahead | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limiting fails the case post only | Executable declaration; result comes from a receipt |
| `restart_while_parked` | An exception parked for approval survives a real runtime restart and cancels once when approved afterwards | Executable declaration; result comes from a receipt |
| `phone_request_opens_ticket` | A phone request without a ticket opens one in Zendesk and works on it | Executable declaration; result comes from a receipt |
| `choice_read_from_customer_reply` | The refund method is read from a new requester-authored reply after the offer | Executable declaration; result comes from a receipt |
| `prorated_credit_tier` | A 45-day-old annual payment gets the unused share as store credit | Executable declaration; result comes from a receipt |
| `store_credit_readback` | Reconciliation retrieves the saved Stripe customer credit ledger entry | Executable declaration; result comes from a receipt |
| `gift_card_balance_readback` | Reconciliation reads the loaded Square gift-card balance | Executable declaration; result comes from a receipt |
| `customer_email_delivery` | Public replies reach the correct customer in the Zendesk twin's simulated mailbox (not live SMTP) | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-product-cancellation-1.0.0-269e897`, verdict **verified**, and statuses: **27 held**.

[Recorded receipt](https://fetchsandbox.com/runs/7c141ce40b?flow=vr_1a9b707387024c149ff1ef377b55630a) · [Saved result](../../acme-ops/verify/receipts/product-cancellation.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/product-cancellation.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/product-cancellation.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)


See the [optional LoopLabs observation and exact approval adapter](../../acme-ops/LOOPLABS.md).

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
