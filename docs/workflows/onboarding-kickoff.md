# Onboarding kickoff

## Business need

Sales needs a reliable closed-won handoff that connects CRM, billing, support and kickoff preparation without silently creating a second subscription.

On closed-won: make the buyer a HubSpot customer, ensure a Stripe customer, provision Zendesk, draft the welcome email and hand off in Slack. Starting the subscription and inviting the customer to kickoff wait for approval.

Demo organization: **Acme Corporation**. Department: **Sales**. Owning team: **sales-ops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "dealId": "D-baseline",
    "company": "Globex",
    "contact": {
      "email": "buyer-baseline@globex.test",
      "firstname": "Hank",
      "lastname": "Scorpio"
    },
    "plan": {
      "priceId": "price_1Pro_Monthly_USD",
      "quantity": 20
    },
    "onboardingChannel": "C0GENERAL01",
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
| `dealId` | yes | string |
| `company` | yes | string |
| `contact` | yes | object |
| `plan` | yes | object |
| `onboardingChannel` | yes | string |
| `csmCalendarId` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `crm-check` | hubspot |
| `billing-check` | stripe |
| `support-check` | zendesk |
| `kickoff-scheduler` | calendar |
| `welcome-composer` | No direct provider requirement; uses input or prior agent results |

**5 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `hubspot.upsert_customer` | hubspot | **auto** | Create/update the buyer's HubSpot contact as lifecyclestage=customer |
| `stripe.ensure_customer` | stripe | **auto** | Find or create the Stripe customer (no charge) |
| `zendesk.provision_requester` | zendesk | **auto** | Create/update the Zendesk organization and requester |
| `gmail.draft_welcome` | gmail | **auto** | Create (not send) the welcome email draft |
| `slack.post_handoff` | slack | **auto** | Post the Sales→CS handoff to the onboarding channel |
| `stripe.create_subscription` | stripe | **approval** | Start the subscription (bills the customer) |
| `calendar.kickoff_invite` | calendar | **approval** | Invite the buyer to the kickoff (sends an invitation) |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=onboarding-kickoff STATE_FILE=.state/onboarding-kickoff.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs onboarding-kickoff
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | Closed-won provisions CRM and Stripe customer, drafts the welcome, hands off in Slack; subscription and kickoff invite wait for approval | Executable declaration; result comes from a receipt |
| `approve_and_reconcile` | Approval starts exactly one subscription; read-back confirms CRM stage, Stripe customer and subscription quantity | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | A non-approver cannot start billing | Executable declaration; result comes from a receipt |
| `reject` | Rejecting withholds the subscription and the invite | Executable declaration; result comes from a receipt |
| `refired_trigger_no_double_subscription` | A closed-won trigger fired again after the first run was approved does not propose a second subscription | Executable declaration; result comes from a receipt |
| `unknown_price_no_stripe_writes` | An unknown price fails the billing check and nothing is created in Stripe | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | Zero seats is rejected before any agent runs | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-delivered closed-won event does not provision twice | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four more simultaneous closed-won deliveries create one run and one Stripe customer | Executable declaration; result comes from a receipt |
| `stripe_auth_failure` | Stripe auth failure: no Stripe writes are attempted; CRM and handoff continue | Executable declaration; result comes from a receipt |
| `hubspot_auth_failure` | HubSpot auth failure: no CRM write; Stripe customer and handoff continue | Executable declaration; result comes from a receipt |
| `slack_not_in_channel` | Slack not_in_channel fails the handoff post only | Executable declaration; result comes from a receipt |
| `calendar_rate_limited` | Calendar rate limiting: no kickoff invite is proposed; billing approval still offered | Executable declaration; result comes from a receipt |
| `restart_while_parked` | A run parked for approval survives a real runtime restart and completes when approved afterwards | Executable declaration; result comes from a receipt |
| `zendesk_provisioning` | The buyer's Zendesk organization and requester are created | FetchSandbox has no Zendesk twin yet; zendesk.provision_requester is recorded as skipped/not_configured. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-onboarding-kickoff-1.0.0-dbab6f7`, verdict **inconclusive**, and statuses: **14 held**, **1 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/f4c3a36343?flow=vr_34dd8797cc094b728307d526149991eb) · [Saved result](../../acme-ops/verify/receipts/onboarding-kickoff.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/onboarding-kickoff.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/onboarding-kickoff.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
