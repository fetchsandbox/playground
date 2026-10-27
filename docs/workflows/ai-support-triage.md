# AI support triage

## Business need

Support needs every new ticket triaged in seconds with a language model, without letting the model lower an outage priority, promise money, or send a reply a person should have checked.

Triage a new Zendesk ticket with a language model under code guards: the answer is schema- and safety-checked, outage and billing priorities have a floor, only confident how-to replies go out without a person, instruction-like ticket text forces approval, and keyword rules take over when the model fails.

Demo organization: **Acme Corporation**. Department: **Support**. Owning team: **support-ops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "ticketId": 800000,
    "supportChannel": "C0SUPPORT01",
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
| `ticketId` | yes | integer |
| `supportChannel` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `ticket-intake` | zendesk |
| `model-triage` | openai, zendesk |
| `triage-decision` | No direct provider requirement; uses input or prior agent results |

**3 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `zendesk.triage` | zendesk | **auto** | Category and source tags, priority and an internal note |
| `zendesk.reply` | zendesk | **auto** | Public reply; automatic only for a confident, checked how-to answer, otherwise approval |
| `slack.post_urgent` | slack | **auto** | Urgent or unreadable tickets in the support channel |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| zendesk | `ZENDESK_SUBDOMAIN` + `ZENDESK_API_KEY` (OAuth token, or API token with `ZENDESK_EMAIL`) |  |
| openai | `OPENAI_API_KEY` (+ optional `OPENAI_MODEL`) | Model output is validated in code and never trusted for money or access decisions. |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=ai-support-triage STATE_FILE=.state/ai-support-triage.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs ai-support-triage
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A new ticket is triaged (tags, priority, internal note) and gets exactly one reply action, automatic or awaiting a person | Executable declaration; result comes from a receipt |
| `model_answers_how_to` | The model classifies a how-to question with confidence and its checked reply goes out without a person | Executable declaration; result comes from a receipt |
| `model_classifies_billing` | The model classifies a double charge as billing; the reply waits for a person because billing replies always do | Executable declaration; result comes from a receipt |
| `model_answer_validated` | Asked for a refund, the model's reply makes no money promise: the answer passes the code checks and is used | Executable declaration; result comes from a receipt |
| `unusable_answer_falls_back` | When the model's answer is unusable (not assistant JSON), keyword rules triage the ticket and the reply waits for a person | Executable declaration; result comes from a receipt |
| `instruction_text_needs_person` | Ticket text that instructs the automation forces the reply to wait for a person | Executable declaration; result comes from a receipt |
| `outage_is_urgent` | An outage ticket is urgent whatever the model says, and posted to Slack | Executable declaration; result comes from a receipt |
| `reply_released_on_approval` | A support lead's approval sends the parked reply once | Executable declaration; result comes from a receipt |
| `reply_rejected` | A rejected reply is never sent | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | Someone who is not an approver can't release a reply | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-delivered ticket is triaged once | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four simultaneous deliveries of one ticket triage it once | Executable declaration; result comes from a receipt |
| `openai_model_overloaded` | When the model is overloaded, rules triage the double charge as high-priority billing and the reply waits | Executable declaration; result comes from a receipt |
| `openai_rate_limited` | When the model is rate limited, rules take over | Executable declaration; result comes from a receipt |
| `openai_quota_exceeded` | When the model quota is exhausted, rules take over | Executable declaration; result comes from a receipt |
| `openai_context_length_exceeded` | When the model rejects the prompt as too long, rules take over | Executable declaration; result comes from a receipt |
| `openai_auth_failure` | When the model credentials are refused, rules take over | Executable declaration; result comes from a receipt |
| `zendesk_rate_limited` | When the ticket can't be read nothing is triaged and Slack is told | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limiting fails the urgent post only; the ticket is still triaged | Executable declaration; result comes from a receipt |
| `restart_while_parked` | A reply parked for approval survives a real runtime restart and is sent once when approved | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A malformed ticket id is rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-ai-support-triage-1.0.0-3abd028`, verdict **failing**, and statuses: **18 held**, **3 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/8b707a425c?flow=vr_7609225e94cb4126a1649d0772bd8bb1) · [Saved result](../../acme-ops/verify/receipts/ai-support-triage.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/ai-support-triage.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/ai-support-triage.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
