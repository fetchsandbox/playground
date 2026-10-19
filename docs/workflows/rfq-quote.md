# RFQ to quote

## Business need

Sales needs a priced response to an RFQ using catalog and customer evidence, with discount approval before finalizing a quote.

Turn an RFQ into a priced Stripe quote: match parts to the catalog, price in code, apply the discount policy (≤10% automatic, ≤30% needs approval, above that declined), update HubSpot and post to Slack. Finalizing a quote with an approval-level discount waits for approval.

Demo organization: **Acme Corporation**. Department: **Sales**. Owning team: **sales-ops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "buyer": {
      "email": "rfq-baseline@globex.test",
      "firstname": "Hank",
      "lastname": "Scorpio"
    },
    "company": "Globex",
    "lines": [
      {
        "product": "Pro Plan",
        "quantity": 20
      }
    ],
    "requestedDiscountPct": 5,
    "salesChannel": "C0GENERAL01",
    "approvers": [
      "U_RVP_SALES"
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
| `buyer` | yes | object |
| `company` | yes | string |
| `lines` | yes | array |
| `requestedDiscountPct` | yes | number |
| `salesChannel` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `catalog-pricing` | stripe |
| `customer-lookup` | stripe |
| `crm-lookup` | hubspot |
| `quote-composer` | No direct provider requirement; uses input or prior agent results |

**4 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `hubspot.upsert_buyer` | hubspot | **auto** | Create/update the buyer contact (opportunity unless already further along) |
| `stripe.ensure_customer` | stripe | **auto** | Find or create the Stripe customer (no charge) |
| `stripe.draft_quote` | stripe | **auto** | Create the draft Stripe quote at catalog prices |
| `stripe.finalize_quote` | stripe | **approval** | Finalize the quote (automatic at ≤10% discount, approval above) |
| `gmail.draft_quote_cover` | gmail | **approval** | Create (not send) the cover email (with the finalize gate) |
| `slack.post_rfq` | slack | **auto** | Post the RFQ outcome or the manual-pricing request to Sales |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=rfq-quote STATE_FILE=.state/rfq-quote.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs rfq-quote
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A small-discount RFQ is priced from the catalog, quoted, finalized and covered automatically | Executable declaration; result comes from a receipt |
| `approval_discount_parks` | A 20% discount drafts the quote but parks finalizing and the cover email for approval | Executable declaration; result comes from a receipt |
| `approve_and_reconcile` | Approval finalizes the quote once and Stripe reads it back as finalized | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | A non-approver cannot release a discounted quote | Executable declaration; result comes from a receipt |
| `reject` | Rejecting leaves the quote in draft and sends nothing | Executable declaration; result comes from a receipt |
| `discount_over_policy_declined` | A 40% request is declined in code: quoted at list price, finalized without approval | Executable declaration; result comes from a receipt |
| `unknown_part_manual_pricing` | An unknown part creates no quote; Sales is asked to price it | Executable declaration; result comes from a receipt |
| `mixed_terms_manual_pricing` | Monthly and yearly lines in one RFQ go to Sales instead of a quote Stripe would reject | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-delivered RFQ creates one quote | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four more simultaneous deliveries create one Stripe customer and one quote | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A zero quantity is rejected before any agent runs | Executable declaration; result comes from a receipt |
| `stripe_rate_limited` | Stripe rate limiting past retries: no quote is attempted, Sales is told to price manually | Executable declaration; result comes from a receipt |
| `hubspot_auth_failure` | HubSpot auth failure skips the CRM update; quoting continues | Executable declaration; result comes from a receipt |
| `restart_while_parked` | A discounted quote parked for approval survives a runtime restart and is finalized once approved | Executable declaration; result comes from a receipt |
| `discount_as_stripe_coupon` | The approved discount is applied on the quote as a Stripe coupon | The Stripe twin rejects discounts on quotes (501 unsupported_checkout_option), so the discount is recorded in quote metadata and applied at invoicing; the coupon path is not exercised. |
| `salesforce_cpq` | Quotes are created in ACME's CPQ / Salesforce opportunity | No Salesforce twin in FetchSandbox; ACME's quote is a Stripe quote and the CRM is HubSpot. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-rfq-quote-1.0.0-7a70b69`, verdict **inconclusive**, and statuses: **14 held**, **2 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/451bef1458?flow=vr_9d553a7d44fe4af4b760c3f63e937ffb) · [Saved result](../../acme-ops/verify/receipts/rfq-quote.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/rfq-quote.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/rfq-quote.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
