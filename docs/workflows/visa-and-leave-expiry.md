# Work authorization and leave dates

## Business need

HR must never let a work authorization lapse unnoticed or lose track of someone returning from leave, months after the date was first recorded.

From a Notion HR compliance row, schedule work-authorization notices (180/90/30 days), an immigration counsel case at 90 days and an I-9 reverification escalation on expiry; for leaves, a return-planning email and manager meeting 14 days before return and an extension check the day after; every timer stands down if the row changed.

Demo organization: **Acme Corporation**. Department: **People**. Owning team: **hr-compliance**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "eventId": "evt_baseline",
    "pageId": "00000000000000000000000000000000",
    "hrChannel": "C0HRCOMPL01",
    "hrCalendarId": "hr@acme.example"
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
| `eventId` | yes | string |
| `pageId` | yes | string |
| `hrChannel` | yes | string |
| `counselWorkspace` | yes | string |
| `hrCalendarId` | yes | string |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `register` | notion |

**1 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `hr.auth_notice` | slack | **auto** | Work authorization notices at 180, 90 and 30 days |
| `asana.counsel_case` | asana | **auto** | Immigration counsel renewal case at 90 days |
| `hr.reverification_overdue` | notion | **auto** | Expired without renewal: mark the row, escalate I-9 reverification |
| `gmail.return_planning` | gmail | **auto** | Return-planning email (draft) 14 days before return |
| `calendar.return_meeting` | calendar | **auto** | Manager check-in on the return day |
| `hr.return_check` | slack | **auto** | No return recorded the day after: check for an extension |
| `slack.post_unreadable` | slack | **auto** | Row unreadable: nothing scheduled |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| notion | `NOTION_API_KEY` (integration token) | Share the database with the integration. Sends `Notion-Version: 2022-06-28`. |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |
| asana | `ASANA_API_KEY` (personal access token) |  |
| gmail | `GMAIL_API_KEY` (OAuth access token) | Customer mail is created as drafts. |
| calendar | `GOOGLE_CALENDAR_API_KEY` (OAuth access token) |  |

**Set up in the provider accounts first:**

- A Notion database with columns `Employee` (title), `Email` (email), `Manager email` (email), `Type` (select: `work_authorization`, `leave`), `Document` (select), `Date` (date) and `Status` (select: `active`, `renewed`, `returned`, `closed`, `reverification_overdue`), shared with the integration.
- A Notion webhook or automation that calls `start` with the page id when a row changes.

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
WORKFLOW=visa-and-leave-expiry STATE_FILE=.state/visa-and-leave-expiry.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs visa-and-leave-expiry
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A request starts one recorded run (provider-independent, so every later check is measured) | Executable declaration; result comes from a receipt |
| `baseline_effects` | A register row is read and classified | Executable declaration; result comes from a receipt |
| `authorization_timers_scheduled` | An authorization 200 days out gets 180/90/30-day notices, a counsel case and an expiry escalation scheduled | Executable declaration; result comes from a receipt |
| `counsel_case_inside_90_days` | An authorization already inside 90 days opens the counsel case at once | Executable declaration; result comes from a receipt |
| `renewed_row_schedules_nothing` | A row marked renewed schedules nothing | Executable declaration; result comes from a receipt |
| `leave_return_planned` | A leave ending in 10 days gets the return email and the manager meeting at once | Executable declaration; result comes from a receipt |
| `expiry_escalates_reverification` | On the expiry date the row is marked overdue and HR is told (needs clock control) | Executable declaration; result comes from a receipt |
| `unrelated_row_ignored` | A row that isn't an authorization or a leave is ignored | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A malformed page id is rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-visa-and-leave-expiry-1.0.0-befeb35`, verdict **failing**, and statuses: **2 held**, **1 unmeasured**, **6 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/83716cae3a?flow=vr_a609579128f94a92a22d0ea14b5ca3fd) · [Saved result](../../acme-ops/verify/receipts/visa-and-leave-expiry.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/visa-and-leave-expiry.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/visa-and-leave-expiry.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
