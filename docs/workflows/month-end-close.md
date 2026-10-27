# Month-end close

## Business need

Controllership needs the books closed on schedule: cash reconciled to the bank, journals proposed and approved by a controller, and the period locked only after sign-off, with a trail auditors accept.

Run the month-end close: reconcile Stripe payouts with bank deposits, propose the Stripe-fee and received-not-billed accrual journals (posted only on a controller's approval, accrual auto-reversing), remind while open, and lock the period only after the controller signs off.

Demo organization: **Acme Corporation**. Department: **Finance**. Owning team: **controllership**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "period": "2026-10",
    "periodName": "Oct 2026",
    "bankAccessToken": "access-sandbox-placeholder",
    "closeChannel": "C0FINANCE01",
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
| `period` | yes | string |
| `periodName` | yes | string |
| `bankAccessToken` | yes | string |
| `closeChannel` | yes | string |
| `closeWorkspace` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `stripe-payouts` | stripe |
| `bank-deposits` | plaid |
| `unbilled-receipts` | netsuite |
| `close-plan` | No direct provider requirement; uses input or prior agent results |

**4 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `netsuite.journal` | netsuite | **auto** | Proposed journal (Stripe fees, received-not-billed accrual with reversal), posted on a controller's approval |
| `asana.recon_exceptions` | asana | **auto** | Unmatched payouts and deposits as an exception task |
| `slack.remind` | slack | **auto** | Day-2 reminder while journals wait |
| `controller.signoff` | netsuite | **auto** | Signal: the controller signs off once journals are settled |
| `netsuite.lock_period` | netsuite | **auto** | Lock the accounting period, only after sign-off |
| `slack.close_status` | slack | **auto** | Close outcome |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| stripe | `STRIPE_API_KEY` (restricted key) | Pinned to Stripe API version `2024-12-18.acacia`; override with `STRIPE_API_VERSION` only after checking the field changes. |
| plaid | `PLAID_CLIENT_ID` + `PLAID_SECRET` (+ `PLAID_BASE_URL` for sandbox) | Credentials travel in the request body. |
| netsuite | `NETSUITE_BASE_URL` (`https://<account>.suitetalk.api.netsuite.com`) + `NETSUITE_API_KEY` (OAuth 2.0 access token) | Tokens expire after 60 minutes; refresh them outside the runtime. |
| asana | `ASANA_API_KEY` (personal access token) |  |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |

**Set up in the provider accounts first:**

- A Plaid link to the operating bank account that receives Stripe payouts, and NetSuite accounting periods named as in the input `periodName`.

**Human decisions (signals).** These steps wait for a named person. Read the waiting action id from `status` (status `awaiting_signal`) and send:

```json
{ "action": "signal", "runId": "<run>", "actionId": "<waiting action id>", "value": "approve", "userId": "<approver id>", "note": "optional" }
```

Senders outside the allowed list, or excluded by segregation-of-duties rules, get HTTP 403.

- `controller.signoff`: the controller signs off once journals are settled

**Timers.** Reminders, deadlines and follow-ups are durable timers. A deployed stack sends `{"action":"tick"}` on the schedule `rate(1 hour)` (EventBridge Scheduler); locally, set `TICK_INTERVAL_MS` or send `tick` yourself.

**Audit trail.** Every decision, signal and effect is hash-chained. `{"action":"evidence","runId":"<run>"}` returns the trail and whether the chain verifies.

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=month-end-close STATE_FILE=.state/month-end-close.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs month-end-close
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A close run starts and posts its status | Executable declaration; result comes from a receipt |
| `payouts_read` | October's Stripe payouts and their fees are read | Executable declaration; result comes from a receipt |
| `bank_feed_read` | The operating account's transactions are read from the bank feed (Plaid) | Executable declaration; result comes from a receipt |
| `payouts_reconciled` | Every payout is matched to a bank deposit within three days | Executable declaration; result comes from a receipt |
| `fee_journal_on_approval` | The Stripe-fee journal posts when the controller approves it | Executable declaration; result comes from a receipt |
| `accrual_reverses_next_period` | The received-not-billed accrual is proposed with a reversal on the first day of the next period | Executable declaration; result comes from a receipt |
| `signoff_locks_period` | After the journals settle, the controller's sign-off locks the period | Executable declaration; result comes from a receipt |
| `reminder_while_open` | On day 2 the controller is reminded of journals still waiting (needs clock control) | Executable declaration; result comes from a receipt |
| `stripe_unreadable_blocks` | Without Stripe the close is blocked and nothing locks | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A malformed period is rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-month-end-close-1.0.0-4ac41d8`, verdict **failing**, and statuses: **4 held**, **3 unmeasured**, **3 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/bf7aec0d1d?flow=vr_f88da1c718664c50bd389823c70535ac) · [Saved result](../../acme-ops/verify/receipts/month-end-close.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/month-end-close.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/month-end-close.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
