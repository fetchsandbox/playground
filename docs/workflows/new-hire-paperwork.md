# New-hire paperwork

## Business need

People Operations needs every new hire to receive the right paperwork for their country and contract, signed and filed before day one, and needs to hear in time, not on the start date, when it is not.

Send a new hire the DocuSign packet their country and employment type call for, with DocuSign reminders and expiry; file the signed packet in Box or Dropbox when Connect reports completion (re-checked with DocuSign); escalate to People Ops before the start date while unsigned, and on decline, void or no signature by day one; packets, templates, cadence and folders are policy.

Demo organization: **Acme Corporation**. Department: **People**. Owning team: **people-ops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "hireId": "H-baseline",
    "employee": {
      "name": "Priya Rao",
      "email": "priya.rao@example.com"
    },
    "country": "US",
    "employmentType": "full_time",
    "startDate": "2026-11-12",
    "manager": {
      "name": "Lee Park",
      "email": "lee@acme.example"
    }
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
| `hireId` | yes | string |
| `employee` | yes | object |
| `country` | yes | string |
| `employmentType` | yes | string / full_time, part_time, intern, contractor |
| `startDate` | yes | string |
| `manager` | yes | object |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `envelopes` | docusign |

**1 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `docusign.send_packet` | docusign | **auto** | Send the policy's packet (composite templates) with DocuSign reminders and expiry; reuses an envelope already sent for the hire |
| `docusign.packet_completed` | box | **auto** | Signal: Connect reports completion (approve) or decline/void (reject); re-checked with DocuSign, then filed in Box or Dropbox |
| `people.unsigned_reminder` | slack | **auto** | Before the start date, People Ops is told the packet isn't signed |
| `people.packet_not_completed` | slack | **auto** | Declined, voided or unsigned by the start date: escalate, naming the manager |
| `slack.post_no_packet` | slack | **auto** | No packet matches the hire: nothing sent |
| `slack.post_too_late` | slack | **auto** | Start date inside the minimum lead time: nothing sent automatically |
| `slack.post_blocked` | slack | **auto** | DocuSign unreadable: nothing sent |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| docusign | `DOCUSIGN_BASE_URL` (your account's base URI) + `DOCUSIGN_API_KEY` (access token) + `DOCUSIGN_ACCOUNT_ID` |  |
| box | `BOX_API_KEY` (access token) | Uploads go to `upload.box.com`; override with `BOX_UPLOAD_URL` only for a test double. |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |

**Set up in the provider accounts first:**

- DocuSign server templates for each packet in the policy, each with a signer role named as the policy's `signerRole` (and the countersigner's role); put their ids in the policy.
- A DocuSign Connect adapter that sends `signal` for `docusign.packet_completed` as the policy's `connectSender`: `approve` on envelope-completed, `reject` on declined or voided.
- An HRIS or ATS hook that calls `start` when a hire is finalized; use the hire id in the run id.
- A Box folder id or Dropbox path as the store root, and the People Ops Slack channel with the bot invited.

**Human decisions (signals).** These steps wait for a named person. Read the waiting action id from `status` (status `awaiting_signal`) and send:

```json
{ "action": "signal", "runId": "<run>", "actionId": "<waiting action id>", "value": "approve", "userId": "<approver id>", "note": "optional" }
```

Senders outside the allowed list, or excluded by segregation-of-duties rules, get HTTP 403.

- `docusign.packet_completed`: Connect reports completion (approve) or decline/void (reject); re-checked with DocuSign, then filed in Box or Dropbox

**Timers.** Reminders, deadlines and follow-ups are durable timers. A deployed stack sends `{"action":"tick"}` on the schedule `rate(1 hour)` (EventBridge Scheduler); locally, set `TICK_INTERVAL_MS` or send `tick` yourself.

**Audit trail.** Every decision, signal and effect is hash-chained. `{"action":"evidence","runId":"<run>"}` returns the trail and whether the chain verifies.

## Configurable policy

Every limit, deadline, routing rule and folder layout lives in [`acme-ops/policies/new-hire-paperwork.json`](../../acme-ops/policies/new-hire-paperwork.json), not in the code. The workflow validates it at startup against its schema and refuses to start on an invalid value. Each run records the policy version it started under and keeps it until it finishes.

Override per deployment without a code change: `POLICY_FILE=/path/override.json` (a mounted file) and/or `POLICY_JSON='{...}'` (an environment value or secret). Objects merge key by key; lists and values replace. On AWS: `cdk deploy -c policyFile:<workflow>=override.json`. `{"action":"describe"}` returns the effective values, their version and the JSON Schema.

| Setting | Default | Meaning |
|---|---|---|
| `store` |  | Where documents are filed |
| `store.provider` | `"box"` | Document store: box or dropbox |
| `store.root` | `"0"` | Box: the root folder id ("0" is All Files). Dropbox: a path such as "/Acme" ("" is the account or team root) |
| `packets` | `[{"name": "US employee", "match": {"country": ["US"], "employmentType": ["full_time", "part_time", "intern"]}, "templates": ["us-offer-letter-template-id", "us-pii-agreement-template-id", "us-handbook-ack-template-id"]}, {"name": "UK employee", "match": {"country": ["GB"], "employmentType": ["full_time", "part_time"]}, "templates": ["uk-employment-contract-template-id", "uk-handbook-ack-template-id"]}, {"name": "Contractor", "match": {"employmentType": ["contractor"]}, "templates": ["contractor-agreement-template-id"]}]` | Packets by country and employment type; first match wins |
| `signerRole` | `"Employee"` | Template role the new hire fills |
| `countersigner` | `{"roleName": "People Team", "name": "Acme People Team", "email": "people@acme.example"}` | Signs after the new hire (null: nobody) |
| `subject` | `"Your Acme paperwork, {firstName}"` | Envelope subject; placeholders: {firstName} {employee} |
| `minLeadDays` | `3` | Don't send when the start date is fewer than this many days away; People Ops is told instead |
| `docusign` |  | DocuSign's own reminders and expiry, set on the envelope |
| `docusign.reminderDelayDays` | `2` | First DocuSign reminder after this many days |
| `docusign.reminderEveryDays` | `2` | Then every this many days |
| `docusign.expireDaysAfterStart` | `7` | The envelope expires this many days after the start date |
| `connectSender` | `"docusign-connect"` | User id your DocuSign Connect adapter signals completion as |
| `escalateDaysBeforeStart` | `[7, 2]` | Tell People Ops this many days before the start date if the packet isn't signed |
| `peopleChannel` | `"C0PEOPLEOPS"` | Slack channel for People Ops |
| `folder` | `"People/Onboarding/{country}/{year}/{employee} ({hireId})"` | Folder for the signed packet; placeholders: {country} {year} {employee} {hireId} {employmentType} |
| `fileName` | `"{date} Onboarding paperwork - {employee}.pdf"` | File name; placeholders: {date} {employee} {hireId} |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=new-hire-paperwork STATE_FILE=.state/new-hire-paperwork.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs new-hire-paperwork
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A finalized hire starts one recorded run (provider-independent, so every later check is measured) | Executable declaration; result comes from a receipt |
| `docusign_unavailable_sends_nothing` | When DocuSign can't be checked for an existing envelope, nothing is sent and People Ops is told | Executable declaration; result comes from a receipt |
| `no_packet_sends_nothing` | A hire no policy packet matches (a country without one) gets nothing sent, decided from policy alone | Executable declaration; result comes from a receipt |
| `duplicate_hire_event` | A re-delivered hire event finds the same run and posts once | Executable declaration; result comes from a receipt |
| `concurrent_hire_events` | Four simultaneous deliveries of the same hire post once | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A hire with a non-ISO country or an invalid email is rejected before any agent runs | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limiting fails the People Ops notice visibly | Executable declaration; result comes from a receipt |
| `restart_then_redelivery` | After a runtime restart, a re-delivered hire event finds the saved run and repeats nothing | Executable declaration; result comes from a receipt |
| `packet_sent_from_templates` | A US full-time hire gets one envelope of the policy's three templates, countersigned by People, with DocuSign reminders and expiry | No DocuSign twin: composite-template envelopes can't be created or read back. |
| `existing_envelope_reused` | A second run for the same hire reuses the envelope found by its external id; nothing is re-sent | Needs DocuSign envelope listing by custom_field. |
| `completion_rechecked_and_filed` | A Connect completion signal is re-checked with DocuSign, then the signed packet and certificate are filed in the employee's folder | Needs a DocuSign envelope that a contract can move to completed, documents/combined bytes, and a store twin that keeps uploads (Box: R29, Dropbox: missing). |
| `forged_completion_refused` | A completion signal while DocuSign says sent files nothing and the run escalates | Needs the DocuSign twin to report a sent envelope. |
| `unsigned_reminders_before_start` | People Ops is told 7 and 2 days before the start date while the packet is unsigned | Needs the DocuSign twin, and the runtime clock to reach the reminder dates during an attempt (fixture time steps are unavailable during an active attempt). |
| `declined_or_unsigned_escalated` | A declined/voided envelope, or no signature by the start date, is escalated naming the manager | Needs the DocuSign twin (declined status) and the start-date deadline inside an attempt. |
| `too_close_start_sends_nothing` | A start date inside the minimum lead time sends nothing automatically | Decided after the existing-envelope check, which needs DocuSign. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-new-hire-paperwork-1.0.0-00c653b`, verdict **inconclusive**, and statuses: **8 held**, **7 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/93652c96db?flow=vr_847c23904d864f0a9e42180279a52b52) · [Saved result](../../acme-ops/verify/receipts/new-hire-paperwork.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/new-hire-paperwork.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/new-hire-paperwork.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
