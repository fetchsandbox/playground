# Data subject access request export (GDPR / CCPA)

## Business need

Privacy teams must answer every access request completely and within the statutory deadline, with identity confirmed and the export reviewed by a second person before anything leaves the company.

Find a data subject's records in HubSpot, Stripe and Zendesk, wait for a privacy team member to confirm their identity, assemble the export and upload it to Box, wait for a different analyst to review it, then draft the response with an expiring link; remind before the statutory deadline and escalate just before it. Incomplete discovery exports nothing.

Demo organization: **Acme Corporation**. Department: **Legal**. Owning team: **privacy-ops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "requestId": "DSAR-baseline",
    "subject": {
      "email": "subject-baseline@dsar.example",
      "name": "Sam Subject"
    },
    "regulation": "gdpr",
    "receivedAt": "2026-10-22T12:00:00.000Z",
    "privacyChannel": "C0PRIVACY01",
    "exportFolderId": "0",
    "verifiers": [
      "U_VERIFIER",
      "U_ANALYST"
    ],
    "analysts": [
      "U_ANALYST",
      "U_ANALYST_2"
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
| `requestId` | yes | string |
| `subject` | yes | object |
| `regulation` | yes | string / gdpr, ccpa |
| `receivedAt` | yes | string |
| `privacyChannel` | yes | string |
| `exportFolderId` | yes | string |
| `verifiers` | yes | array |
| `analysts` | yes | array |
| `dsarWorkspace` | yes | string |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `crm` | hubspot |
| `billing` | stripe |
| `support` | zendesk |

**3 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `asana.dsar_record` | asana | **auto** | Request record with the statutory deadline (no personal data) |
| `slack.post_blocked` | slack | **auto** | Discovery incomplete: nothing exported |
| `privacy.verify_identity` | asana | **auto** | Signal: a privacy team member confirms the requester's identity |
| `box.upload_export` | box | **auto** | Assemble the export from source systems and upload it once |
| `privacy.approve_export` | asana | **auto** | Signal: an analyst other than the verifier reviews and releases the export |
| `box.share_link` | box | **auto** | Expiring download link |
| `gmail.draft_response` | gmail | **auto** | Response draft to the requester (not sent) |
| `slack.remind` | slack | **auto** | Reminder ahead of the statutory deadline |
| `privacy.escalate` | slack | **auto** | Escalation just before the deadline |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| hubspot | `HUBSPOT_API_KEY` (private-app token) | Custom contact properties must exist before the workflow writes them. |
| stripe | `STRIPE_API_KEY` (restricted key) | Pinned to Stripe API version `2024-12-18.acacia`; override with `STRIPE_API_VERSION` only after checking the field changes. |
| zendesk | `ZENDESK_SUBDOMAIN` + `ZENDESK_API_KEY` (OAuth token, or API token with `ZENDESK_EMAIL`) |  |
| asana | `ASANA_API_KEY` (personal access token) |  |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |
| box | `BOX_API_KEY` (access token) | Uploads go to `upload.box.com`; override with `BOX_UPLOAD_URL` only for a test double. |
| gmail | `GMAIL_API_KEY` (OAuth access token) | Customer mail is created as drafts. |

**Set up in the provider accounts first:**

- A restricted Box folder for exports (input `exportFolderId`).

**Human decisions (signals).** These steps wait for a named person. Read the waiting action id from `status` (status `awaiting_signal`) and send:

```json
{ "action": "signal", "runId": "<run>", "actionId": "<waiting action id>", "value": "approve", "userId": "<approver id>", "note": "optional" }
```

Senders outside the allowed list, or excluded by segregation-of-duties rules, get HTTP 403.

- `privacy.verify_identity`: a privacy team member confirms the requester's identity
- `privacy.approve_export`: an analyst other than the verifier reviews and releases the export

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
WORKFLOW=dsar-export STATE_FILE=.state/dsar-export.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs dsar-export
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | An access request is recorded against its statutory deadline | Executable declaration; result comes from a receipt |
| `discovery_complete` | The subject is found in CRM, billing and support, and the request waits for identity | Executable declaration; result comes from a receipt |
| `verified_export_uploaded` | Once identity is confirmed the export is assembled and uploaded to Box | Executable declaration; result comes from a receipt |
| `verifier_cannot_release` | Whoever confirmed identity can't also release the export | Executable declaration; result comes from a receipt |
| `release_drafts_response` | A second analyst's release creates an expiring link and a response draft (not sent) | Executable declaration; result comes from a receipt |
| `deadline_escalation` | A request still open three days before the deadline is escalated (needs clock control) | Executable declaration; result comes from a receipt |
| `support_unavailable_blocks` | When support can't be searched nothing is exported and privacy-ops is told | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A malformed request id is rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-dsar-export-1.0.0-06c2f09`, verdict **failing**, and statuses: **3 held**, **3 unmeasured**, **2 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/d18e6b7bda?flow=vr_898103f011f8472f969dde72d7c22bd1) · [Saved result](../../acme-ops/verify/receipts/dsar-export.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/dsar-export.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/dsar-export.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
