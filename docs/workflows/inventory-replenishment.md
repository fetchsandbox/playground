# Inventory replenishment

## Business need

Supply chain needs stock reordered before it runs out, in the quantities suppliers accept, without double-ordering, and needs to know when a supplier is late.

Compute each SKU's reorder need from Shopify sales velocity, available stock and open NetSuite POs; raise one PO per supplier per day (approval over the limit), email it to the supplier as a draft, escalate POs not received two days after their due date, and flag SKUs that will stock out before replenishment arrives.

Demo organization: **Acme Corporation**. Department: **Operations**. Owning team: **supply-chain**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "runId": "REPL-baseline",
    "locationId": "9000000002",
    "department": "3",
    "items": [
      {
        "sku": "MUG-BLK",
        "variantId": "9000000001",
        "netsuiteItemId": "101",
        "supplierId": "401",
        "unitCost": 500,
        "leadTimeDays": 10,
        "safetyDays": 5,
        "moq": 1,
        "casePack": 1
      }
    ],
    "suppliers": {
      "401": {
        "name": "Ceramica",
        "email": "orders@ceramica.example"
      }
    },
    "opsChannel": "C0SUPPLY001",
    "approvers": [
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
| `runId` | yes | string |
| `locationId` | yes | string |
| `department` | yes | string |
| `items` | yes | array |
| `suppliers` | yes | object |
| `opsChannel` | yes | string |
| `approvers` | yes | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `velocity` | shopify |
| `stock` | shopify |
| `open-pos` | netsuite |
| `plan` | No direct provider requirement; uses input or prior agent results |

**4 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `netsuite.create_po` | netsuite | **auto** | One PO per supplier per day; approval over 10,000 |
| `gmail.po_to_supplier` | gmail | **auto** | PO to the supplier (draft) |
| `receiving.late_check` | netsuite | **auto** | Escalate lines not received two days after the due date |
| `slack.post_replenishment` | slack | **auto** | Summary, stockout risks and SKUs that couldn't be planned |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=inventory-replenishment STATE_FILE=.state/inventory-replenishment.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs inventory-replenishment
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A replenishment run reads sales, stock and open POs and posts a summary | Executable declaration; result comes from a receipt |
| `velocity_from_orders` | 28-day sales velocity is computed from Shopify orders | Executable declaration; result comes from a receipt |
| `stock_from_inventory_levels` | Available units come from Shopify inventory levels at the location | Executable declaration; result comes from a receipt |
| `open_pos_counted` | Units on open purchase orders are read from the ERP | Executable declaration; result comes from a receipt |
| `below_reorder_point_po_raised` | A SKU below its reorder point gets a purchase order and a supplier email | Executable declaration; result comes from a receipt |
| `large_po_needs_buyer` | A PO over 10,000 waits for a buyer | Executable declaration; result comes from a receipt |
| `late_receipt_escalated` | A PO not received two days after its due date is escalated (needs clock control) | Executable declaration; result comes from a receipt |
| `shopify_rate_limited` | When stock can't be read nothing is ordered | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A non-numeric variant id is rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-inventory-replenishment-1.0.0-4ac41d8`, verdict **failing**, and statuses: **3 held**, **6 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/a456cd9e4c?flow=vr_35867ebfc10b434e938b5117c9d12c39) · [Saved result](../../acme-ops/verify/receipts/inventory-replenishment.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/inventory-replenishment.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/inventory-replenishment.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
