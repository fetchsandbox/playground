# Inbound lead follow-up

## Business need

A small sales team needs every web-form lead followed up reliably: one CRM deal, one follow-up email and one booked follow-up call per lead, no duplicates when a form is resubmitted or a provider times out, and a person told exactly what to do whenever a step cannot be confirmed.

On a lead form submission: find or create the HubSpot contact, create one sales deal, send one follow-up email through Gmail, book a Calendar follow-up only after the email is confirmed, and tell the team in Slack it is done or exactly which step is blocked. Every write reconciles before it repeats; an unconfirmed email gets an initial lookup and lookups 15 and 30 minutes after the send, then a person.

Demo organization: **Acme Corporation**. Department: **Sales**. Owning team: **sales-team**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "leadId": "L-baseline",
    "name": "Ada Lovelace",
    "email": "lead-baseline@example.test"
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
| `leadId` | yes | string |
| `name` | yes | string |
| `email` | yes | string |
| `salesChannel` | no/default | string |
| `handoffUserId` | no/default | string |
| `calendarId` | yes | string |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|

**0 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `hubspot.find_or_create_contact` | hubspot | **auto** | Find the contact by email or create it (409 adopts the existing one) |
| `hubspot.create_deal` | hubspot | **auto** | Create the lead's one sales deal (named 'Lead <leadId> · <name>'), associated to the contact |
| `gmail.send_followup` | gmail | **auto** | Send the follow-up email once (deterministic Message-ID); an unknown outcome gets an initial lookup, then lookups 15 and 30 minutes after the send, never a resend |
| `calendar.create_followup_event` | calendar | **auto** | After the email is confirmed, create the follow-up call event (deterministic event id, no invitation sent) |
| `slack.notify_team` | slack | **auto** | Tell the team the lead is done, or hand the blocked step to a person with instructions |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| hubspot | `HUBSPOT_API_KEY` (private-app token) | Custom contact properties must exist before the workflow writes them. |
| gmail | `GMAIL_API_KEY` (OAuth access token) | Customer mail is created as drafts. |
| calendar | `GOOGLE_CALENDAR_API_KEY` (OAuth access token) |  |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |

**Set up in the provider accounts first:**

- A HubSpot private-app token with CRM contacts and deals read/write scopes; a Gmail mailbox token allowed to send and read messages (`gmail.send` + `gmail.readonly`); a Google Calendar token for the follow-up calendar; a Slack bot token with `chat:write` and `channels:history`, invited to the team channel. Set `LEAD_FOLLOWUP_SLACK_CHANNEL` and optionally `LEAD_FOLLOWUP_OWNER_SLACK_ID` (the person who takes over blocked leads). A web-form adapter that calls `start` is not included.

**Timers.** Reminders, deadlines and follow-ups are durable timers. A deployed stack sends `{"action":"tick"}` on the schedule `rate(1 minute)` (EventBridge Scheduler); locally, set `TICK_INTERVAL_MS` or send `tick` yourself.

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=lead-follow-up STATE_FILE=.state/lead-follow-up.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs lead-follow-up
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | New lead: one contact, one verified deal, one confirmed email, then one event, then one Slack completion | Executable declaration; result comes from a receipt |
| `existing_contact_adopted` | Existing HubSpot contact is adopted, not duplicated or overwritten | Executable declaration; result comes from a receipt |
| `resubmitted_lead_joins_run` | Resubmitted lead (new submission id) joins the run; nothing written twice | Executable declaration; result comes from a receipt |
| `concurrent_first_submissions` | 5 concurrent first submissions: one run, one of each effect | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | Malformed submissions are rejected before any write; saved run state is not readable without the verifier token | Executable declaration; result comes from a receipt |
| `reconcile_reads_back` | Reconcile reads every effect back from its provider: all match | Executable declaration; result comes from a receipt |
| `hubspot_deal_response_loss` | Deal accepted, response lost: no repeat; re-check finds it by lead token and id, no second deal | Executable declaration; result comes from a receipt |
| `gmail_send_response_loss` | Email accepted, response lost: no resend; initial lookup confirms it, then booked | Executable declaration; result comes from a receipt |
| `gmail_unresolved_handoff` | Email outcome unresolvable: initial + 2 scheduled lookups (across a restart), no resend, no event, Slack handoff | Executable declaration; result comes from a receipt |
| `gmail_send_rejected` | Send always refused: at most 3 tries, nothing sent or booked, handoff | Executable declaration; result comes from a receipt |
| `gmail_send_rejected_once` | Send refused once: re-checked, sent once, then booked | Executable declaration; result comes from a receipt |
| `gmail_auth_failure` | Gmail auth failure: blocked at email, nothing sent or booked, handoff | Executable declaration; result comes from a receipt |
| `gmail_rate_limited` | Gmail rate limited: bounded re-checks, nothing sent, handoff | Executable declaration; result comes from a receipt |
| `hubspot_auth_failure` | HubSpot auth failure: blocked at contact, nothing downstream, handoff | Executable declaration; result comes from a receipt |
| `hubspot_scope_denied` | HubSpot writes forbidden: bounded re-checks, handoff, nothing downstream | Executable declaration; result comes from a receipt |
| `hubspot_rate_limited` | HubSpot rate limited: bounded re-checks, no writes, no email, handoff | Executable declaration; result comes from a receipt |
| `calendar_auth_failure` | Calendar auth failure: email stays single, handoff for the event only | Executable declaration; result comes from a receipt |
| `calendar_rate_limited` | Calendar rate limited: bounded re-checks, no second email, handoff | Executable declaration; result comes from a receipt |
| `slack_channel_not_found` | Slack channel_not_found: notification recorded failed, never as sent | Executable declaration; result comes from a receipt |
| `slack_not_in_channel` | Slack not_in_channel: notification recorded failed | Executable declaration; result comes from a receipt |
| `slack_missing_scope` | Slack missing_scope: notification recorded failed | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limited: bounded re-checks, recorded failed, effects single | Executable declaration; result comes from a receipt |
| `slack_slow_network_single_post` | Slack slower than the client timeout: the post is found in history, never posted twice | Executable declaration; result comes from a receipt |
| `restart_during_confirmation` | Runtime killed while its send is in flight: stale claim taken over, lookup confirms, never resent | Executable declaration; result comes from a receipt |
| `midrun_resubmission_while_waiting` | Resubmission with changed details while the run waits: joins it, first data used, nothing to the new address | Executable declaration; result comes from a receipt |
| `two_leads_isolated` | Two different leads: two runs, each with only its own contact, deal, email, event and post | Executable declaration; result comes from a receipt |
| `hubspot_token_expired` | HubSpot token dies mid-run: stops at the failing step, handoff, no email | Executable declaration; result comes from a receipt |
| `email_confirmation_spacing_30_minutes` | The confirmation lookups run right after the unknown send and 15 and 30 minutes after it, then the handoff | Measured attempt (rev 2, vr_7f0015df...): the real-time check reached its +15.0 min lookup, then the managed relay lease expired (manage_tunnel expires_in_seconds 1800; a second open is refused until close, and a new tunnel gets a new URL the configured run cannot follow), so the observation returned HTTP 503 and every later check lost its app. The execution budget allows 3300 s but no relay lease outlives 1800 s, and the 30-minute schedule plus setup needs more. Measured separately through the caller-executed arm/probe path (provider traffic, app_verified false); see the evidence record. |
| `midrun_provider_change_by_person` | A person creates the lead's deal or sends the follow-up by hand while the run waits; the run adopts it instead of duplicating | Driving a provider-side change between app actions needs a qualified external_operator input; discovery returns qualified_external_inputs: [] for hubspot, gmail, google-calendar and slack. The app's reconcile-first lookups would adopt such records (deal by lead token, email by Message-ID); covered by local tests only. |
| `multi_worker_shared_store` | Two live workers drive the same stored run at once (multi-container): one claim owner, no duplicate effect, the run still finishes | The relay runner starts exactly one runtime process with a local file store; FetchSandbox cannot start a second worker against the same storage. Measured locally only: two engines on one store race a stale claim (one takeover, no resend), which exposed and fixed a stranded-WAITING settle race in the engine. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-lead-follow-up-1.0.0-e09e6da`, verdict **inconclusive**, and statuses: **25 held**, **5 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/3d902dfd1a?flow=vr_2b5550810ed94ba6ae8b98114cc0bb8f) · [Saved result](../../acme-ops/verify/receipts/lead-follow-up.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/lead-follow-up.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/lead-follow-up.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
