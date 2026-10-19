# Returns and warranty (RMA)

## Business need

Customer Experience needs to establish purchase and warranty eligibility before arranging a return or issuing a credit.

Verify the purchase and warranty of a failed unit against the Stripe invoice, open the RMA for the returns dock, draft return instructions and post to Slack. A warranty credit note waits for approval and is never offered out of warranty or on an unpaid invoice.

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
    "partNumber": "GEMS-LS-200 level switch",
    "serial": "SN-baseline",
    "failure": "Switch output stuck high after two weeks in service.",
    "returnsChannel": "C0BILLING01",
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

| Field | Required | Type / allowed values |
|---|---|---|
| `customer` | yes | object |
| `invoiceId` | yes | string |
| `partNumber` | yes | string |
| `serial` | no/default | string |
| `failure` | yes | string |
| `creditRequested` | yes | boolean |
| `creditAmountMinor` | no/default | integer |
| `returnsChannel` | yes | string |
| `returnsWorkspace` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `order-lookup` | stripe |
| `account-context` | hubspot |
| `ticket-history` | zendesk |
| `rma-composer` | No direct provider requirement; uses input or prior agent results |

**4 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `asana.create_rma` | asana | **auto** | Open the RMA task for the returns dock (verified purchases only) |
| `gmail.draft_rma_instructions` | gmail | **auto** | Create (not send) the return-instructions draft |
| `slack.post_rma` | slack | **auto** | Post the RMA (or the failed verification) to the returns channel |
| `stripe.warranty_credit_note` | stripe | **approval** | Issue a warranty credit note on the paid invoice (in warranty only) |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=returns-warranty STATE_FILE=.state/returns-warranty.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs returns-warranty
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | An in-warranty failure on a paid invoice opens the RMA, drafts return instructions, posts to Slack and parks the warranty credit for approval | Executable declaration; result comes from a receipt |
| `approve_by_approver` | The CX lead's approval issues exactly one warranty credit note | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | A non-approver cannot issue a credit | Executable declaration; result comes from a receipt |
| `reject` | Rejecting withholds the credit; the RMA still stands | Executable declaration; result comes from a receipt |
| `unpaid_invoice_no_credit` | A return against an unpaid invoice gets an RMA but no credit (AR handles it) | Executable declaration; result comes from a receipt |
| `no_credit_requested` | Repair-only returns propose no credit | Executable declaration; result comes from a receipt |
| `someone_elses_invoice_refused` | A claim against another customer's invoice issues no RMA, only a Slack note for manual verification | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-delivered return request opens one RMA | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four more simultaneous deliveries of one request open one RMA | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A request without a Stripe invoice id is rejected before any agent runs | Executable declaration; result comes from a receipt |
| `stripe_auth_failure` | Without Stripe the purchase can't be verified: no RMA and no credit | Executable declaration; result comes from a receipt |
| `asana_rate_limited` | Asana rate limiting fails the RMA task only; the draft, Slack post and credit approval continue | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limiting fails the post only | Executable declaration; result comes from a receipt |
| `restart_while_parked` | A credit parked for approval survives a real runtime restart and is issued when approved afterwards | Executable declaration; result comes from a receipt |
| `carrier_return_label` | A prepaid carrier return label is created with the RMA | No carrier twin (UPS/FedEx/EasyPost/Shippo) in FetchSandbox; the RMA asks the customer to ship to the returns address instead. |
| `zendesk_ticket_link` | The customer's Zendesk ticket history is read and the RMA is linked to the ticket | FetchSandbox has no Zendesk twin yet; the ticket-history agent is skipped/not_configured. |
| `credit_note_amount_readback` | Reconciliation confirms the issued credit note's amount in Stripe | The Stripe twin's credit_notes create/get return sample amounts, not the amount sent, so the read-back reports drift on the twin. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-returns-warranty-1.0.0-df79afd`, verdict **inconclusive**, and statuses: **14 held**, **3 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/d196fed8ac?flow=vr_e0778cfd16fd4a1db57cf35861be60d9) · [Saved result](../../acme-ops/verify/receipts/returns-warranty.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/returns-warranty.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/returns-warranty.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
