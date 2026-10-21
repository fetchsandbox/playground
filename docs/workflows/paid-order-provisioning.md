# Paid order provisioning (Stripe events)

## Business need

Sales needs to grant product access the moment an order is paid, and never for an order that was not paid in full, was refunded or disputed, or whose payment event was forged, replayed, delayed or lost.

Charge a customer's saved card for seats, then grant access only when Stripe says the order is paid in full: a signed payment_intent.succeeded webhook (or the same request forwarded through AgentCore) starts provisioning, the payment is re-read from Stripe rather than trusted from the event, refunded, disputed, underpaid or foreign payments grant nothing, and a sweep provisions paid orders whose event never arrived. Access is a WorkOS user and organization membership, the CRM contact becomes a customer, the welcome email is a draft, and the payment records which run provisioned it.

Demo organization: **Acme Corporation**. Department: **Sales**. Owning team: **order-ops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-co-{{run_id}}",
  "input": {
    "stage": "checkout",
    "orderId": "ORD-baseline",
    "customer": {
      "email": "po-baseline@orders.test"
    },
    "plan": "team",
    "seats": 3,
    "organizationId": "org_seeded",
    "paymentMethod": "pm_card_visa",
    "opsChannel": "C0BILLING01",
    "approvers": [
      "U_SALES_LEAD"
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
| `stage` | yes | string / checkout |
| `orderId` | yes | string |
| `customer` | yes | object |
| `plan` | yes | string / team, business |
| `seats` | yes | integer |
| `organizationId` | yes | string |
| `paymentMethod` | no/default | string |
| `opsChannel` | yes | string |
| `approvers` | no/default | array |

### Input variant 2

| Field | Required | Type / allowed values |
|---|---|---|
| `stage` | yes | string / payment_event |
| `paymentIntentId` | yes | string |
| `eventId` | no/default | string |
| `opsChannel` | yes | string |
| `approvers` | no/default | array |

### Input variant 3

| Field | Required | Type / allowed values |
|---|---|---|
| `stage` | yes | string / sweep |
| `customers` | yes | array |
| `minAgeMinutes` | yes | integer |
| `opsChannel` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `checkout-check` | stripe |
| `payment-check` | stripe |
| `directory` | workos |

**3 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `stripe.charge_order` | stripe | **auto** | Charge the saved card for the seats; approval above $5,000; never twice for one order |
| `stripe.claim_order` | stripe | **auto** | Claim the paid order on the payment before granting access (another run's fresh claim stops this one) |
| `workos.grant_access` | workos | **auto** | Find or create the buyer's WorkOS user and add the organization membership; approval above 200 seats |
| `hubspot.mark_customer` | hubspot | **auto** | Upsert the CRM contact as a customer |
| `gmail.draft_welcome` | gmail | **auto** | Draft (not send) the welcome email after access is granted |
| `stripe.record_provisioned` | stripe | **auto** | Record on the payment which run provisioned it (the cross-run ledger) |
| `slack.post_order` | slack | **auto** | Order feed in the ops channel, including refused and held orders |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=paid-order-provisioning STATE_FILE=.state/paid-order-provisioning.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs paid-order-provisioning
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A seat purchase charges the customer's saved card once and records the order on the payment | Executable declaration; result comes from a receipt |
| `payment_event_provisions` | The order's signed payment event grants WorkOS access, marks the CRM customer, drafts the welcome and records the provisioning run on the payment | Executable declaration; result comes from a receipt |
| `provisioning_reconciled` | Reconcile reads the WorkOS membership and the payment's provisioning record back | Executable declaration; result comes from a receipt |
| `exact_replay_once` | An exact replay of the delivered event lands on the same order run and grants nothing twice | Executable declaration; result comes from a receipt |
| `concurrent_deliveries_once` | Four simultaneous deliveries of the payment event grant access once | Executable declaration; result comes from a receipt |
| `unknown_payment_ignored` | A signed event for a payment Stripe doesn't know is acknowledged and starts nothing | Executable declaration; result comes from a receipt |
| `stale_event_after_refund` | A payment refunded before its success event arrives grants nothing: the runtime re-reads Stripe instead of trusting the event | Executable declaration; result comes from a receipt |
| `withheld_event_swept` | When the payment event never arrives, the missed-event sweep provisions the paid order | Executable declaration; result comes from a receipt |
| `late_event_after_sweep` | An event arriving after the sweep provisioned the order changes nothing | Executable declaration; result comes from a receipt |
| `checkout_retry_charges_once` | Re-running checkout for an order that was already charged charges nothing | Executable declaration; result comes from a receipt |
| `large_charge_parked` | A charge above $5,000 waits for approval; nothing is charged | Executable declaration; result comes from a receipt |
| `large_charge_stranger_refused` | Someone who is not an approver cannot release a large charge | Executable declaration; result comes from a receipt |
| `large_charge_rejected` | A rejected large charge is never made | Executable declaration; result comes from a receipt |
| `large_order_access_reviewed` | An approved 250-seat charge is made once, and its payment event parks access for onboarding review | Executable declaration; result comes from a receipt |
| `duplicate_checkout` | A re-delivered checkout trigger charges once | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A checkout with a malformed order id is rejected before any agent runs | Executable declaration; result comes from a receipt |
| `unknown_customer_not_charged` | A checkout for an address with no Stripe customer charges nothing | Executable declaration; result comes from a receipt |
| `workos_auth_failure` | With the directory refusing, access and the provisioning record fail; nothing is marked provisioned | Executable declaration; result comes from a receipt |
| `hubspot_rate_limited` | A CRM outage only loses the customer mark; access is still granted and recorded | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limiting fails the order post only | Executable declaration; result comes from a receipt |
| `restart_while_parked` | A large charge parked for approval survives a real runtime restart and is charged once when approved | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-paid-order-provisioning-1.0.0-2eb0421`, verdict **verified**, and statuses: **21 held**.

[Recorded receipt](https://fetchsandbox.com/runs/1d788244db?flow=vr_10847645f51e49e5987d6c22bee177e6) · [Saved result](../../acme-ops/verify/receipts/paid-order-provisioning.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/paid-order-provisioning.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/paid-order-provisioning.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
