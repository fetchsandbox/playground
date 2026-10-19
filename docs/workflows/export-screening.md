# Export screening and order hold

## Business need

Trade Compliance needs to hold shipment when party or item screening is unclear rather than treating an unavailable check as clearance.

Screen each order's parties, items and destination before it ships; hold anything not confirmed clean (fail-safe), open a compliance review and alert the channel. Releasing a hold requires approval.

Demo organization: **Acme Corporation**. Department: **Trade Compliance**. Owning team: **trade-compliance**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "orderRef": "SO-1001",
    "customerEmail": "alice@acmecorp.com",
    "partyName": "Acme Corp",
    "shipToCountry": "DE",
    "endUse": "Utility substation transformer monitoring",
    "productIds": [
      "prod_SaaS_ProPlan"
    ],
    "complianceChannel": "C0GENERAL01",
    "approvers": [
      "U_EXPORT_OFFICER"
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
| `orderRef` | yes | string |
| `customerEmail` | yes | string |
| `partyName` | yes | string |
| `shipToCountry` | yes | string |
| `endUse` | yes | string |
| `productIds` | yes | array |
| `complianceChannel` | yes | string |
| `asanaWorkspace` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `item-classification` | stripe |
| `party-screening` | screening |
| `customer-record` | stripe |

**3 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `stripe.place_export_hold` | stripe | **auto** | Hold the account's orders (Stripe customer metadata export_hold) |
| `asana.compliance_review` | asana | **auto** | Open a compliance review task with the hold reasons |
| `slack.post_hold_alert` | slack | **auto** | Alert the compliance channel |
| `stripe.release_export_hold` | stripe | **approval** | Release the hold (never for embargoed destinations) |
| `stripe.record_clearance` | stripe | **auto** | Record a clean screening on the account |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=export-screening STATE_FILE=.state/export-screening.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs export-screening
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | An order that can't be fully screened is held: account flagged, review opened, channel alerted; release waits for approval | Executable declaration; result comes from a receipt |
| `embargoed_destination_cannot_be_released` | An order to an embargoed destination is held and offers no release | Executable declaration; result comes from a receipt |
| `unknown_customer_still_reviewed` | An unknown buyer gets a review and an alert even with no account to flag | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | A non-officer cannot release a hold | Executable declaration; result comes from a receipt |
| `reject` | Rejecting keeps the hold | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A country name instead of an ISO code is rejected | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-delivered order event does not open a second review | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four more simultaneous deliveries create one run | Executable declaration; result comes from a receipt |
| `stripe_auth_failure` | Without Stripe the items can't be classified: still held, reviewed and alerted | Executable declaration; result comes from a receipt |
| `asana_auth_failure` | Asana failure fails the review task only; the hold stands | Executable declaration; result comes from a receipt |
| `slack_channel_not_found` | Slack failure fails the alert only; the hold stands | Executable declaration; result comes from a receipt |
| `restart_while_parked` | A held order survives a real runtime restart; the officer's decision afterwards is honored | Executable declaration; result comes from a receipt |
| `approve_and_reconcile` | The officer's release clears the hold and the read-back confirms it | Executable declaration; result comes from a receipt |
| `restricted_party_screening` | Parties are screened against the restricted-party lists and a clean order is cleared automatically | No FetchSandbox twin for the Trade.gov Consolidated Screening List (or any screening provider); the runtime treats screening as unavailable and holds every order. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-export-screening-1.0.0-7e9260e`, verdict **inconclusive**, and statuses: **13 held**, **1 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/ae8c32ab75?flow=vr_0630f2bf77114f0faaed8f22ece14c8a) · [Saved result](../../acme-ops/verify/receipts/export-screening.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/export-screening.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/export-screening.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
