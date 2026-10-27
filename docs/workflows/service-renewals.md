# Service and monitoring renewals

## Business need

Customer Success needs advance notice of expiring service contracts and coordinated renewal follow-up, with review for policy-level price changes.

Sweep monitoring and calibration contracts (Stripe subscriptions) renewing in the next 30/60/90 days; create the owner's renewal task, draft the renewal email, find a call slot and post a digest. Uplifts above policy wait for approval.

Demo organization: **Acme Corporation**. Department: **Customer Success**. Owning team: **cs-ops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "csChannel": "C0GENERAL01",
    "upliftPct": 7,
    "maxAutoUpliftPct": 5,
    "approvers": [
      "U_CS_DIRECTOR"
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
| `csChannel` | yes | string |
| `asanaWorkspace` | yes | string |
| `csmCalendarId` | yes | string |
| `asOf` | no/default | string |
| `windowDays` | yes | integer |
| `accounts` | yes | array |
| `upliftPct` | yes | number |
| `maxAutoUpliftPct` | yes | number |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `renewal-ledger` | stripe |
| `account-context` | hubspot, stripe |
| `renewal-call-slots` | calendar |

**3 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `slack.post_renewal_digest` | slack | **auto** | Post the renewal digest to the CS channel |
| `asana.renewal_task` | asana | **auto** | Create the owner's renewal task, due on the renewal date |
| `gmail.draft_renewal` | gmail | **auto** | Create (not send) the renewal email draft |
| `stripe.schedule_uplift` | stripe | **approval** | Schedule the renewal price uplift on the subscription (auto when within policy) |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| stripe | `STRIPE_API_KEY` (restricted key) | Pinned to Stripe API version `2024-12-18.acacia`; override with `STRIPE_API_VERSION` only after checking the field changes. |
| hubspot | `HUBSPOT_API_KEY` (private-app token) | Custom contact properties must exist before the workflow writes them. |
| calendar | `GOOGLE_CALENDAR_API_KEY` (OAuth access token) |  |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |
| asana | `ASANA_API_KEY` (personal access token) |  |
| gmail | `GMAIL_API_KEY` (OAuth access token) | Customer mail is created as drafts. |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=service-renewals STATE_FILE=.state/service-renewals.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs service-renewals
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | Renewal sweep: owner tasks, renewal drafts and digest for both renewing contracts; the above-policy uplift waits for approval | Executable declaration; result comes from a receipt |
| `uplift_within_policy_is_automatic` | A 3% uplift (within the 5% policy) is scheduled without approval | Executable declaration; result comes from a receipt |
| `no_uplift_past_due` | No uplift is proposed for a past-due account | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | A non-approver cannot raise a customer's price | Executable declaration; result comes from a receipt |
| `reject` | Rejecting keeps the current price | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | An 80% uplift is rejected before any agent runs | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-fired schedule does not create tasks or drafts twice | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four more simultaneous firings create one run | Executable declaration; result comes from a receipt |
| `stripe_auth_failure` | If Stripe can't be read, nothing is created | Executable declaration; result comes from a receipt |
| `asana_auth_failure` | Asana auth failure fails the owner tasks only; drafts and digest continue | Executable declaration; result comes from a receipt |
| `calendar_auth_failure` | Without the CSM calendar the drafts go out without a proposed call time | Executable declaration; result comes from a receipt |
| `restart_while_parked` | A pending uplift survives a real runtime restart and is applied when approved afterwards | Executable declaration; result comes from a receipt |
| `approve_and_reconcile` | Approved uplift is written to the subscription and read back | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-service-renewals-1.0.0-7e9260e`, verdict **verified**, and statuses: **13 held**.

[Recorded receipt](https://fetchsandbox.com/runs/335177d131?flow=vr_aa323bfd73a1418aad16a46b2a53675e) · [Saved result](../../acme-ops/verify/receipts/service-renewals.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/service-renewals.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/service-renewals.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
