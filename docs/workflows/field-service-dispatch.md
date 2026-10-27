# Field service dispatch

## Business need

Service needs to coordinate technician time, contract coverage and site communication before committing an uncovered or after-hours visit.

Turn an asset alarm into a dispatch: find the earliest free technician, check the service contract in Stripe, open the Asana work order, text the site contact and post to Slack. Booking an after-hours or uncovered (billable) visit waits for approval.

Demo organization: **Acme Corporation**. Department: **Service**. Owning team: **field-service**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "alarm": {
      "id": "ALM-baseline",
      "site": "Austin Substation 4",
      "asset": "QTMS transformer monitor T2",
      "severity": "critical",
      "description": "Dissolved gas level above threshold."
    },
    "account": {
      "email": "alice@acmecorp.com"
    },
    "sitePhone": "+15125550100",
    "technicianCalendars": [
      "tech.rivera@acme.example",
      "tech.okafor@acme.example"
    ],
    "dispatchChannel": "C0INCIDENT",
    "approvers": [
      "U_FS_MANAGER"
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
| `alarm` | yes | object |
| `account` | yes | object |
| `sitePhone` | yes | string |
| `technicianCalendars` | yes | array |
| `afterHours` | yes | boolean |
| `dispatchChannel` | yes | string |
| `workspace` | yes | string |
| `fromNumber` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `technician-availability` | calendar |
| `service-contract` | stripe |
| `site-account` | hubspot |
| `dispatch-planner` | No direct provider requirement; uses input or prior agent results |

**4 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `asana.create_work_order` | asana | **auto** | Open the field work order |
| `twilio.notify_site` | twilio | **auto** | Text the site contact that the alarm is being handled |
| `slack.post_dispatch` | slack | **auto** | Post the dispatch to the field-service channel |
| `calendar.book_technician` | calendar | **approval** | Book the technician (automatic under contract in hours; approval after hours or when billable) |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| calendar | `GOOGLE_CALENDAR_API_KEY` (OAuth access token) |  |
| stripe | `STRIPE_API_KEY` (restricted key) | Pinned to Stripe API version `2024-12-18.acacia`; override with `STRIPE_API_VERSION` only after checking the field changes. |
| hubspot | `HUBSPOT_API_KEY` (private-app token) | Custom contact properties must exist before the workflow writes them. |
| asana | `ASANA_API_KEY` (personal access token) |  |
| twilio | `TWILIO_API_KEY` (auth token) + `TWILIO_ACCOUNT_SID` | HTTP Basic auth. |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=field-service-dispatch STATE_FILE=.state/field-service-dispatch.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs field-service-dispatch
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | An in-hours alarm under contract opens the work order, texts the site, posts to Slack and books the technician automatically | Executable declaration; result comes from a receipt |
| `after_hours_needs_approval` | An after-hours callout parks the booking for approval | Executable declaration; result comes from a receipt |
| `billable_needs_approval` | An alarm from a site without a service contract parks the (billable) booking for approval | Executable declaration; result comes from a receipt |
| `approve_and_reconcile` | Approval books the technician; Asana and Twilio read back the work order and SMS | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | A non-approver cannot authorize an after-hours callout | Executable declaration; result comes from a receipt |
| `reject` | Rejecting leaves the visit unbooked; the work order stays open | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-delivered alarm opens one work order and sends one SMS | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four more simultaneous alarm deliveries open one work order and send one SMS | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A site phone that isn't E.164 is rejected before any agent runs | Executable declaration; result comes from a receipt |
| `twilio_invalid_number` | Twilio refusing the number fails the SMS only; the work order and booking proceed | Executable declaration; result comes from a receipt |
| `calendar_auth_failure` | Without technician calendars no booking is attempted; the work order and SMS still go out | Executable declaration; result comes from a receipt |
| `stripe_auth_failure` | If the contract can't be verified the visit is treated as billable and parked for approval | Executable declaration; result comes from a receipt |
| `asana_rate_limited` | Asana rate limiting fails the work order only; the site is still texted | Executable declaration; result comes from a receipt |
| `restart_while_parked` | An after-hours booking parked for approval survives a runtime restart and is booked once approved | Executable declaration; result comes from a receipt |
| `parts_reservation` | Spare parts for the asset are reserved from inventory with the work order | No ERP/inventory twin (SAP/Oracle/NetSuite) in FetchSandbox; parts are listed in the work order for the technician to pick manually. |
| `calendar_booking_readback` | Reconciliation reads the booked visit back from the technician's calendar | The Calendar twin returns 404 on events.get right after a successful insert, so the booking can't be read back. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-field-service-dispatch-1.0.0-36fbb6e`, verdict **inconclusive**, and statuses: **14 held**, **2 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/11328921ab?flow=vr_6fa5507329d94f57a25f1dcdd6f271b8) · [Saved result](../../acme-ops/verify/receipts/field-service-dispatch.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/field-service-dispatch.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/field-service-dispatch.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
