# Support escalation

## Business need

Support needs to combine incident severity, account context and billing health so urgent cases reach the right team with a reviewed customer reply.

Triage a Zendesk ticket against the customer's CRM record, billing health and the support lead's calendar; annotate the ticket, escalate in Slack, hold a callback slot and draft the reply. The public reply waits for approval.

Demo organization: **Acme Corporation**. Department: **Support**. Owning team: **support-ops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "ticket": {
      "id": 4242,
      "subject": "Dashboard down for our whole team",
      "description": "Everyone gets a 503 error since 9am.",
      "requester": {
        "email": "alice@acmecorp.com",
        "name": "Alice Johnson"
      }
    },
    "escalationChannel": "C0INCIDENT",
    "approvers": [
      "U_SUPPORT_LEAD"
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
| `ticket` | yes | object |
| `escalationChannel` | yes | string |
| `supportCalendarId` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `ticket-triage` | No direct provider requirement; uses input or prior agent results |
| `account-context` | hubspot |
| `billing-health` | stripe |
| `callback-availability` | calendar |
| `reply-composer` | No direct provider requirement; uses input or prior agent results |

**5 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `zendesk.annotate_ticket` | zendesk | **auto** | Set priority and tags; add an internal note with the account brief |
| `slack.post_escalation` | slack | **auto** | Post the escalation to the support escalation channel (high/urgent only) |
| `calendar.hold_callback` | calendar | **auto** | Hold a callback slot on the support lead's calendar (no attendees) |
| `gmail.draft_reply` | gmail | **auto** | Create (not send) a Gmail draft of the customer reply |
| `zendesk.public_reply` | zendesk | **approval** | Post the reply publicly on the ticket |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| hubspot | `HUBSPOT_API_KEY` (private-app token) | Custom contact properties must exist before the workflow writes them. |
| stripe | `STRIPE_API_KEY` (restricted key) | Pinned to Stripe API version `2024-12-18.acacia`; override with `STRIPE_API_VERSION` only after checking the field changes. |
| calendar | `GOOGLE_CALENDAR_API_KEY` (OAuth access token) |  |
| zendesk | `ZENDESK_SUBDOMAIN` + `ZENDESK_API_KEY` (OAuth token, or API token with `ZENDESK_EMAIL`) |  |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |
| gmail | `GMAIL_API_KEY` (OAuth access token) | Customer mail is created as drafts. |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=support-escalation STATE_FILE=.state/support-escalation.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs support-escalation
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | Urgent ticket from a paying customer is escalated, a callback is held, a reply is drafted, and the public reply waits for approval | Executable declaration; result comes from a receipt |
| `approve_by_approver` | The named approver's approval completes the run | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | An approval from someone who is not an approver is refused and changes nothing | Executable declaration; result comes from a receipt |
| `reject` | Rejecting withholds the public reply | Executable declaration; result comes from a receipt |
| `duplicate_start` | Re-sending the same trigger does not run the workflow twice | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four more simultaneous deliveries of one trigger create one run and one escalation | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A trigger without a requester email is rejected before any agent runs | Executable declaration; result comes from a receipt |
| `low_severity_not_escalated` | A how-to question from a non-customer is not escalated to Slack | Executable declaration; result comes from a receipt |
| `slack_channel_not_found` | Slack channel_not_found fails only the escalation post; the run is partial and the draft still exists | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limiting past retries is recorded as a failed post, not a lost run | Executable declaration; result comes from a receipt |
| `stripe_auth_failure` | Stripe auth failure isolates the billing agent; triage and escalation continue | Executable declaration; result comes from a receipt |
| `hubspot_auth_failure` | HubSpot auth failure isolates the account agent; escalation continues | Executable declaration; result comes from a receipt |
| `calendar_auth_failure` | Calendar auth failure means no callback hold is attempted; escalation continues | Executable declaration; result comes from a receipt |
| `gmail_rate_limited` | Gmail rate limiting fails only the reply draft | Executable declaration; result comes from a receipt |
| `restart_while_parked` | A run parked for approval survives a real runtime restart and completes when approved afterwards | Executable declaration; result comes from a receipt |
| `zendesk_ticket_annotation` | Ticket is annotated (priority, tags, internal note) and the approved reply is posted publicly in Zendesk | FetchSandbox has no Zendesk twin yet; the runtime records zendesk.* actions as skipped/not_configured. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-support-escalation-1.0.0-dbab6f7`, verdict **inconclusive**, and statuses: **15 held**, **1 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/a3e6951d42?flow=vr_560dd52d3f244aaba40f6d925ae8c5c7) · [Saved result](../../acme-ops/verify/receipts/support-escalation.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/support-escalation.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/support-escalation.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
