# Order to cash with shipping

## Business need

Operations needs every paid storefront order booked in the ERP before a label is bought, shipped once, and tracked for the customer, holding anything unpaid or incomplete.

Ship a paid Shopify order: book it as a NetSuite sales order, buy the cheapest EasyPost label under a cost limit, then add the fulfillment with tracking to Shopify. Nothing ships without a sales order; unpaid, cancelled or incomplete orders are held; large orders and expensive labels need approval.

Demo organization: **Acme Corporation**. Department: **Operations**. Owning team: **fulfillment-ops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "orderId": "ORDER_baseline",
    "opsChannel": "C0OPS00001",
    "approvers": [
      "U_OPS_LEAD"
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
| `orderId` | yes | string |
| `opsChannel` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `order-check` | shopify |
| `erp-check` | netsuite |
| `fulfillment-decision` | No direct provider requirement; uses input or prior agent results |

**3 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `netsuite.book_sales_order` | netsuite | **auto** | Book the NetSuite sales order (external id shopify-<order>); approval above $10,000 |
| `easypost.buy_label` | easypost | **auto** | Buy the cheapest USD label under $50, only after the sales order exists |
| `shopify.fulfill` | shopify | **auto** | Add the fulfillment with tracking to the Shopify order (notifies the customer) |
| `slack.post_order` | slack | **auto** | Order outcome in the operations channel |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| shopify | `SHOPIFY_BASE_URL` (`https://<shop>.myshopify.com`) + `SHOPIFY_API_KEY` (Admin API access token) | Admin API version `2026-01`; override with `SHOPIFY_API_VERSION`. |
| netsuite | `NETSUITE_BASE_URL` (`https://<account>.suitetalk.api.netsuite.com`) + `NETSUITE_API_KEY` (OAuth 2.0 access token) | Tokens expire after 60 minutes; refresh them outside the runtime. |
| easypost | `EASYPOST_API_KEY` | HTTP Basic auth. |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |

**Set up in the provider accounts first:**

- A NetSuite customer whose email matches the Shopify order, and NetSuite items whose external ids are the Shopify SKUs.

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=order-to-cash STATE_FILE=.state/order-to-cash.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs order-to-cash
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A request starts one recorded run (provider-independent, so every later check is measured) | Executable declaration; result comes from a receipt |
| `baseline_effects` | A paid order is read from Shopify and its outcome posted to operations | Executable declaration; result comes from a receipt |
| `sales_order_booked_in_erp` | A paid, complete order is booked as a NetSuite sales order (external id shopify-<order>) | Executable declaration; result comes from a receipt |
| `label_bought_under_limit` | After the sales order, the cheapest EasyPost label under $50 is bought | Executable declaration; result comes from a receipt |
| `customer_gets_tracking` | The Shopify order gets a fulfillment with the label's tracking number | Executable declaration; result comes from a receipt |
| `shipped_order_not_shipped_again` | An order that already has a fulfillment is not shipped again | Executable declaration; result comes from a receipt |
| `unpaid_order_held` | An order that isn't paid is held: no sales order, no label | Executable declaration; result comes from a receipt |
| `incomplete_address_held` | An order without a complete shipping address is held | Executable declaration; result comes from a receipt |
| `cancelled_order_ignored` | A cancelled order is not shipped | Executable declaration; result comes from a receipt |
| `shopify_rate_limited` | When the order can't be read nothing ships and operations is alerted | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A malformed order id is rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-order-to-cash-1.0.0-befeb35`, verdict **failing**, and statuses: **3 held**, **8 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/e62545113b?flow=vr_cfd2d89105c2494eafa5054ce7cd773a) · [Saved result](../../acme-ops/verify/receipts/order-to-cash.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/order-to-cash.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/order-to-cash.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
