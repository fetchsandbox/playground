# Delivery exception handling

## Business need

Customers should hear about a late or lost parcel from us before they have to ask, and get a replacement without a fight, exactly once.

Classify a shipment from its EasyPost scans; tell the customer first through one Zendesk ticket when it's delayed, stuck or in exception, re-check after 48 hours and either solve the ticket or send a free Shopify replacement; lost or returned shipments are replaced at once, over 200 with a lead's approval.

Demo organization: **Acme Corporation**. Department: **Operations**. Owning team: **fulfillment-ops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "eventId": "evt_baseline",
    "trackerId": "trk_baseline",
    "orderId": "90001488064692",
    "opsChannel": "C0FULFIL001",
    "approvers": [
      "U_LEAD"
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
| `eventId` | yes | string |
| `trackerId` | yes | string |
| `orderId` | yes | string |
| `opsChannel` | yes | string |
| `approvers` | yes | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `tracking` | easypost |
| `order` | shopify |

**2 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `zendesk.proactive_notice` | zendesk | **auto** | One ticket per shipment with a public apology |
| `easypost.recheck` | easypost | **auto** | Re-read the tracker 48 hours later; solve the ticket if delivered |
| `shopify.replacement` | shopify | **auto** | Free replacement once per shipment; approval over 200 |
| `slack.post_unreadable` | slack | **auto** | Tracker or order unreadable: nothing done |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=delivery-exception STATE_FILE=.state/delivery-exception.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs delivery-exception
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A request starts one recorded run (provider-independent, so every later check is measured) | Executable declaration; result comes from a receipt |
| `baseline_effects` | A tracker update is read together with its order | Executable declaration; result comes from a receipt |
| `stuck_parcel_customer_told` | A parcel with no scan for 3 days opens one proactive ticket | Executable declaration; result comes from a receipt |
| `lost_parcel_replaced` | A parcel with no scan for 7 days is replaced at no cost | Executable declaration; result comes from a receipt |
| `returned_parcel_replaced` | A parcel returned to sender is replaced | Executable declaration; result comes from a receipt |
| `delivered_after_notice_solves_ticket` | Delivered within 48 hours: the ticket is solved and nothing is replaced (needs clock control) | Executable declaration; result comes from a receipt |
| `redelivered_webhook_one_ticket` | The same tracker update delivered twice opens one ticket | Executable declaration; result comes from a receipt |
| `tracker_unreadable_reported` | A tracker that can't be read changes nothing for the customer | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A malformed tracker id is rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-delivery-exception-1.0.0-06c2f09`, verdict **failing**, and statuses: **4 held**, **5 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/2750a6afec?flow=vr_59e842134e84480d8beaa68bd37fe374) · [Saved result](../../acme-ops/verify/receipts/delivery-exception.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/delivery-exception.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/delivery-exception.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
