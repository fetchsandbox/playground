# Revenue reconciliation

## Business need

Finance needs to detect differences between payment, CRM and support approval records before applying corrective writes.

Reconcile paying Stripe customers against HubSpot customers and Stripe refunds against Zendesk refund approvals; post the variance report to Finance and propose CRM fixes for approval.

Demo organization: **Acme Corporation**. Department: **Finance**. Owning team: **revops-finance**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "financeChannel": "G0PRIVATE01",
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
| `financeChannel` | yes | string |
| `maxCrmFixes` | yes | integer |
| `refundApprovalTag` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `stripe-ledger` | stripe |
| `crm-ledger` | hubspot |
| `support-ledger` | zendesk |

**3 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `slack.post_report` | slack | **auto** | Post the variance report to the Finance channel |
| `hubspot.mark_customer` | hubspot | **approval** | Create/update the HubSpot contact of a paying customer with lifecyclestage=customer |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=revenue-reconciliation STATE_FILE=.state/revenue-reconciliation.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs revenue-reconciliation
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | Month-end run posts the variance report and proposes one gated CRM fix per paying customer missing from HubSpot | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | A non-approver cannot apply CRM fixes | Executable declaration; result comes from a receipt |
| `reject` | Rejecting leaves HubSpot untouched | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-delivered close trigger does not post the report twice | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four more simultaneous close triggers produce one run and one report | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A channel name instead of a channel id is rejected | Executable declaration; result comes from a receipt |
| `hubspot_auth_failure` | If HubSpot can't be read, nothing is reconciled or posted (no false variances) | Executable declaration; result comes from a receipt |
| `hubspot_rate_limited` | HubSpot rate limiting past retries also stops the reconciliation rather than reporting a partial ledger | Executable declaration; result comes from a receipt |
| `stripe_auth_failure` | If Stripe can't be read, nothing is reconciled or posted | Executable declaration; result comes from a receipt |
| `slack_channel_not_found` | A Slack failure fails the report only; the CRM fixes still await approval | Executable declaration; result comes from a receipt |
| `restart_while_parked` | A run parked for approval survives a real runtime restart; the decision taken afterwards is honored | Executable declaration; result comes from a receipt |
| `approve_and_reconcile` | Approved CRM fixes are applied and read back from HubSpot as matching | Executable declaration; result comes from a receipt |
| `refund_approval_matching` | Every Stripe refund is matched to an approved Zendesk ticket; unmatched refunds are reported | FetchSandbox has no Zendesk twin yet; refunds are reported as unverified (refundsUnverified) instead of approved. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-revenue-reconciliation-1.0.0-dbab6f7`, verdict **inconclusive**, and statuses: **12 held**, **1 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/a630507692?flow=vr_deac92d8f5264a81bdfe6a17d17192ca) · [Saved result](../../acme-ops/verify/receipts/revenue-reconciliation.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/revenue-reconciliation.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/revenue-reconciliation.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
