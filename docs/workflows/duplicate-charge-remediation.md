# Duplicate charge remediation

## Business need

Finance needs to refund customers who were charged twice by a billing incident, quickly and at scale, without refunding a disputed or ambiguous payment and with human approval above set limits.

After a billing incident, scan the affected customers' Stripe payments in the incident window, find purchases charged twice, exclude disputed and ambiguous ones, and refund the duplicates under hard limits: small refunds go out automatically, large ones and anything past the batch limit wait for approval, and an incident beyond the automation ceiling refunds nothing and goes to people. Customer notices are Gmail drafts; the record goes to Asana and Slack.

Demo organization: **Acme Corporation**. Department: **Finance**. Owning team: **billing-ops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "incidentId": "INC-baseline",
    "description": "Payment retry job ran twice and charged customers a second time.",
    "customers": [
      "dup-baseline@billing.test"
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

| Field | Required | Type / allowed values |
|---|---|---|
| `incidentId` | yes | string |
| `description` | yes | string |
| `window` | no/default | object |
| `customers` | yes | array |
| `financeChannel` | yes | string |
| `financeWorkspace` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `charge-scan` | stripe |
| `dispute-check` | stripe |
| `account-context` | hubspot |
| `remediation-plan` | No direct provider requirement; uses input or prior agent results |

**4 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `stripe.refund_duplicate` | stripe | **auto** | Refund one duplicate charge; approval above the single-refund or batch limit |
| `gmail.draft_notice` | gmail | **auto** | Draft (not send) the customer notice, only after that customer's refunds went out |
| `asana.remediation_record` | asana | **auto** | Remediation record for finance and audit |
| `slack.post_digest` | slack | **auto** | Incident digest in the finance channel |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=duplicate-charge-remediation STATE_FILE=.state/duplicate-charge-remediation.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs duplicate-charge-remediation
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A purchase charged twice is refunded once, the customer notice is drafted, and the remediation is recorded and posted | Executable declaration; result comes from a receipt |
| `refund_reconciled` | Reconcile reads the refund back from Stripe with the planned amount | Executable declaration; result comes from a receipt |
| `large_refund_parked` | A refund above the single-refund limit waits for approval, and so does that customer's notice | Executable declaration; result comes from a receipt |
| `large_refund_approved` | The controller's approval issues the large refund exactly once | Executable declaration; result comes from a receipt |
| `large_refund_rejected` | A rejected large refund is never issued | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | Someone who is not an approver cannot release a refund | Executable declaration; result comes from a receipt |
| `rerun_refunds_nothing` | Running the same incident again (a new trigger) finds the duplicate already refunded and refunds nothing | Executable declaration; result comes from a receipt |
| `ambiguous_not_refunded` | Same-amount payments with nothing saying what they were for are left to a person | Executable declaration; result comes from a receipt |
| `different_purchase_kept` | A different purchase in the same window is not refunded | Executable declaration; result comes from a receipt |
| `two_customers` | Duplicates for two customers are refunded in parallel, one notice each | Executable declaration; result comes from a receipt |
| `ceiling_halts` | An incident beyond the automation ceiling refunds nothing and escalates | Executable declaration; result comes from a receipt |
| `unknown_customer` | An address with no Stripe customer is reported, not refunded | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-delivered incident trigger refunds once | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four simultaneous deliveries of one incident refund once | Executable declaration; result comes from a receipt |
| `invalid_window_rejected` | An incident window longer than seven days is rejected before any agent runs | Executable declaration; result comes from a receipt |
| `stripe_auth_failure` | Without Stripe nothing is refunded; the incident is still recorded and posted | Executable declaration; result comes from a receipt |
| `hubspot_rate_limited` | A CRM outage only loses account context; refunds still go out | Executable declaration; result comes from a receipt |
| `gmail_auth_failure` | A mailbox failure fails the notice draft only | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limiting fails the digest only | Executable declaration; result comes from a receipt |
| `restart_while_parked` | A refund parked for approval survives a real runtime restart and is issued once when approved | Executable declaration; result comes from a receipt |
| `disputed_charge_excluded` | A duplicate whose charge is disputed is excluded from refunds | The Stripe twin can't open a dispute on a charge created in the session (pm_card_createDispute is not simulated; seeded disputes reference charges that don't exist). Covered by local tests. |
| `dispute_outage_fails_closed` | If the dispute list can't be read, nothing is refunded | Twin faults apply to the whole Stripe twin, so the dispute read can't fail on its own while the payment scan succeeds. Covered by local tests. |
| `manual_refund_race` | A duplicate refunded by hand between scan and refund is not refunded again | Needs a write to the twin between two steps of one run. Covered by local tests (the refund re-checks the refundable amount at write time). |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-duplicate-charge-remediation-1.0.0-72ac909`, verdict **inconclusive**, and statuses: **20 held**, **3 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/beb3fd7432?flow=vr_d1c0a9d00be3459ebdeca462bebcf8c4) · [Saved result](../../acme-ops/verify/receipts/duplicate-charge-remediation.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/duplicate-charge-remediation.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/duplicate-charge-remediation.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
