# Collections and credit hold

## Business need

Finance needs consistent overdue-invoice follow-up while protecting disputed accounts from an inappropriate credit hold.

Tier open, past-due Stripe invoices by age; draft reminders, post the AR digest, and propose a credit hold for the most overdue accounts. Holds wait for approval; disputed invoices are never held.

Demo organization: **Acme Corporation**. Department: **Finance**. Owning team: **ar-collections**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "arChannel": "C0BILLING01",
    "approvers": [
      "U_AR_MANAGER"
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
| `arChannel` | yes | string |
| `asOf` | no/default | string |
| `minDaysOverdue` | yes | integer |
| `holdAfterDays` | yes | integer |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `ar-ledger` | stripe |
| `account-owners` | hubspot, stripe |

**2 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `slack.post_ar_digest` | slack | **auto** | Post the past-due digest to the AR channel |
| `gmail.draft_reminder` | gmail | **auto** | Create (not send) a tiered reminder draft per past-due invoice |
| `stripe.credit_hold` | stripe | **approval** | Put the account on credit hold (Stripe customer metadata credit_hold=true) |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=collections-credit-hold STATE_FILE=.state/collections-credit-hold.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs collections-credit-hold
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | Daily AR sweep: digest posted, tiered reminder drafted, credit hold on the 60+ day account waits for approval | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | A non-approver cannot put a customer on credit hold | Executable declaration; result comes from a receipt |
| `reject` | Rejecting leaves the account open for orders | Executable declaration; result comes from a receipt |
| `nothing_overdue_is_quiet` | When nothing is past the threshold, nothing is posted or drafted | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A channel name instead of a channel id is rejected | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-fired schedule does not post or draft twice | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four more simultaneous firings create one run | Executable declaration; result comes from a receipt |
| `stripe_auth_failure` | If Stripe can't be read, nothing is drafted, posted or held | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limiting fails the digest only; the reminder and the hold proposal stand | Executable declaration; result comes from a receipt |
| `gmail_auth_failure` | Gmail auth failure fails the reminder draft only | Executable declaration; result comes from a receipt |
| `hubspot_auth_failure` | Without HubSpot the owners are unknown, but collections still run | Executable declaration; result comes from a receipt |
| `restart_while_parked` | A proposed hold survives a real runtime restart; the decision taken afterwards is honored | Executable declaration; result comes from a receipt |
| `approve_and_reconcile` | Approved hold is written to the Stripe customer and read back | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-collections-credit-hold-1.0.0-7e9260e`, verdict **verified**, and statuses: **13 held**.

[Recorded receipt](https://fetchsandbox.com/runs/05add583db?flow=vr_1fa37c3665834dee8d573aa5ab82349e) · [Saved result](../../acme-ops/verify/receipts/collections-credit-hold.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/collections-credit-hold.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/collections-credit-hold.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
