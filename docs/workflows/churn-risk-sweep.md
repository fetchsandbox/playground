# Churn-risk sweep

## Business need

Customer Success needs an explainable shortlist of accounts to contact before renewal, using billing, CRM, support and inbox evidence instead of one isolated score.

Score each account's churn risk from Stripe billing, HubSpot engagement, Zendesk tickets and inbox activity; post a digest, draft check-in emails for high-risk accounts and propose QBR invites for approval.

Demo organization: **Acme Corporation**. Department: **Customer Success**. Owning team: **cs-ops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "accounts": [
      {
        "email": "alice@acmecorp.com",
        "name": "Alice Johnson"
      },
      {
        "email": "dev@startupxyz.io",
        "name": "Dev Patel"
      }
    ],
    "csChannel": "C0BILLING01",
    "approvers": [
      "U_CS_LEAD"
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
| `accounts` | yes | array |
| `csChannel` | yes | string |
| `csmCalendarId` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `billing-signal` | stripe |
| `engagement-signal` | hubspot |
| `support-signal` | zendesk |
| `inbox-signal` | gmail |
| `csm-availability` | calendar |
| `risk-scorer` | No direct provider requirement; uses input or prior agent results |

**6 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `slack.post_digest` | slack | **auto** | Post the risk digest to the CS channel (only when something is medium/high) |
| `gmail.draft_checkin` | gmail | **auto** | Create (not send) a check-in draft for each high-risk account |
| `calendar.book_qbr` | calendar | **approval** | Invite a high-risk account to a QBR on the CSM's calendar (sends an invitation) |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| stripe | `STRIPE_API_KEY` (restricted key) | Pinned to Stripe API version `2024-12-18.acacia`; override with `STRIPE_API_VERSION` only after checking the field changes. |
| hubspot | `HUBSPOT_API_KEY` (private-app token) | Custom contact properties must exist before the workflow writes them. |
| zendesk | `ZENDESK_SUBDOMAIN` + `ZENDESK_API_KEY` (OAuth token, or API token with `ZENDESK_EMAIL`) |  |
| gmail | `GMAIL_API_KEY` (OAuth access token) | Customer mail is created as drafts. |
| calendar | `GOOGLE_CALENDAR_API_KEY` (OAuth access token) |  |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=churn-risk-sweep STATE_FILE=.state/churn-risk-sweep.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs churn-risk-sweep
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | Weekly sweep flags the past-due account: digest posted, check-in drafted, QBR invite waits for approval | Executable declaration; result comes from a receipt |
| `approve_by_approver` | Approval sends the QBR invite | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | A non-approver cannot send customer invites | Executable declaration; result comes from a receipt |
| `reject` | Rejecting withholds the invite | Executable declaration; result comes from a receipt |
| `healthy_book_is_quiet` | A book with no at-risk accounts posts nothing and drafts nothing | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | Duplicate accounts in one sweep are rejected | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-fired schedule does not post the digest twice | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four more simultaneous schedule firings create one run | Executable declaration; result comes from a receipt |
| `stripe_auth_failure` | Without billing data the sweep reports the gap instead of calling the account healthy | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limiting fails the digest only; the check-in draft is still created | Executable declaration; result comes from a receipt |
| `calendar_auth_failure` | Without the CSM's calendar no invite is proposed; drafts and digest continue | Executable declaration; result comes from a receipt |
| `gmail_auth_failure` | Gmail auth failure loses the inbox signal and the draft, but the account is still flagged | Executable declaration; result comes from a receipt |
| `restart_while_parked` | A run parked for approval survives a real runtime restart and completes when approved afterwards | Executable declaration; result comes from a receipt |
| `support_signal` | Open and urgent Zendesk tickets raise the account's risk score | FetchSandbox has no Zendesk twin yet; the support signal is reported in signalGaps. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-churn-risk-sweep-1.0.0-dbab6f7`, verdict **inconclusive**, and statuses: **13 held**, **1 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/4c1386197c?flow=vr_4750363d6121468999f2717ee7fa0956) · [Saved result](../../acme-ops/verify/receipts/churn-risk-sweep.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/churn-risk-sweep.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/churn-risk-sweep.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
