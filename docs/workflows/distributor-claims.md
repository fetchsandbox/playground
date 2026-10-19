# Distributor rebate and point-of-sale claims

## Business need

Channel Finance needs to compare requested distributor credits with the actual paid invoices, list prices and agreement before paying them.

Validate a distributor's ship-and-debit claims against its paid Stripe invoices, list prices and agreement; post the decisions, draft the reply, and pay approved credit as a Stripe balance credit after approval.

Demo organization: **Acme Corporation**. Department: **Finance**. Owning team: **channel-finance**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "distributorEmail": "alice@acmecorp.com",
    "claims": [
      {
        "claimId": "C-1",
        "invoiceId": "in_3QaT2bVwXy5zA6Bc7D",
        "productId": "prod_SaaS_ProPlan",
        "qty": 2,
        "claimedUnitPriceMinor": 4165,
        "endCustomer": "Initech Utilities"
      },
      {
        "claimId": "C-2",
        "invoiceId": "in_3QaT2bVwXy5zA6Bc7D",
        "productId": "prod_SaaS_ProPlan",
        "qty": 2,
        "claimedUnitPriceMinor": 2450,
        "endCustomer": "Initech Utilities"
      },
      {
        "claimId": "C-3",
        "invoiceId": "in_7EfG8hIjKl9mN0Op1Q",
        "productId": "prod_SaaS_ProPlan",
        "qty": 2,
        "claimedUnitPriceMinor": 4165,
        "endCustomer": "Initech Utilities"
      }
    ],
    "agreement": {
      "maxDiscountPct": 20
    },
    "financeChannel": "G0PRIVATE01",
    "approvers": [
      "U_CHANNEL_FINANCE"
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
| `distributorEmail` | yes | string |
| `claims` | yes | array |
| `agreement` | yes | object |
| `financeChannel` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `invoice-ledger` | stripe |
| `price-list` | stripe |
| `distributor-account` | hubspot |

**3 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `slack.post_claims_summary` | slack | **auto** | Post claim decisions to the finance channel |
| `gmail.draft_claim_decisions` | gmail | **auto** | Create (not send) the decisions email to the distributor |
| `stripe.credit_claims` | stripe | **approval** | Credit the approved amount to the distributor's Stripe balance |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=distributor-claims STATE_FILE=.state/distributor-claims.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs distributor-claims
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | Claims are validated (approve, partial, deny), the decisions are posted and drafted, and the credit waits for approval | Executable declaration; result comes from a receipt |
| `all_denied_pays_nothing` | A batch with only invalid claims proposes no credit | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | A non-approver cannot pay a claim | Executable declaration; result comes from a receipt |
| `reject` | Rejecting pays nothing | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | Two claims with the same id are rejected before any agent runs | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-submitted batch does not post or draft twice | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four more simultaneous submissions create one run | Executable declaration; result comes from a receipt |
| `stripe_auth_failure` | If Stripe can't be read, no claim is decided or paid | Executable declaration; result comes from a receipt |
| `hubspot_auth_failure` | HubSpot is context only: claims are still decided | Executable declaration; result comes from a receipt |
| `slack_channel_not_found` | Slack failure fails the summary only | Executable declaration; result comes from a receipt |
| `restart_while_parked` | A pending credit survives a real runtime restart; the decision taken afterwards is honored | Executable declaration; result comes from a receipt |
| `approve_and_reconcile` | The approved credit is posted to the distributor's Stripe balance and read back | Executable declaration; result comes from a receipt |
| `invoice_line_validation` | Each claim's product and quantity are checked against the invoice's line items | Stripe twin invoices carry no line items (GET /v1/invoices/{id} lines.data = [] and /lines returns []), so claims are only checked against the invoice's paid amount (invoiceCheck=amount_only). |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-distributor-claims-1.0.0-7e9260e`, verdict **inconclusive**, and statuses: **12 held**, **1 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/229b5a3ee6?flow=vr_7df15a9babc7455c852404002f0c1f29) · [Saved result](../../acme-ops/verify/receipts/distributor-claims.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/distributor-claims.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/distributor-claims.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
