# Lead follow-up

## Business need

Sales needs reliable inbound follow-up: every form lead gets a HubSpot contact and Deal, one follow-up email, a calendar hold only after email success is confirmed, and a Slack notice on completion or a blocked step — without duplicate Deals, duplicate emails or silent failures.

On form submit (lead ID, name, email): find or create the HubSpot contact and sales Deal, send a Gmail follow-up (Message-ID keyed; timeouts reconcile before any retry), run three confirmation lookups over 30 minutes when delivery is unresolved, create a Calendar event only after email success, and notify Slack on completion or hand off to a person with clear instructions.

Demo organization: **Acme Corporation**. Department: **Sales**. Owning team: **sales-ops**. Configure your own named owner when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "leadId": "L-baseline",
    "name": "Alex Buyer",
    "email": "lead-baseline@example.test",
    "salesChannel": "C0SALES0001",
    "calendarId": "primary",
    "confirmWindowMs": 0
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

`gmail.send_followup` sends mail on the configured mailbox twin. Confirmation is Sent-label / Message-ID read-back, not proof of SMTP delivery to an external inbox. Calendar is withheld until email success is confirmed.

## Input contract

| Field | Required | Type / allowed values |
|---|---|---|
| `leadId` | yes | string |
| `name` | yes | string |
| `email` | yes | email |
| `salesChannel` | yes | Slack channel id |
| `calendarId` | no/default | string (`primary`) |
| `confirmWindowMs` | no/default | int (default 30 minutes; proofs may use `0`) |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `crm-check` | hubspot |
| `followup-composer` | No direct provider requirement; uses input or prior agent results |

**2 declared roles**, including the compose stage. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `hubspot.upsert_contact` | hubspot | **auto** | Find or create the HubSpot contact for the lead email |
| `hubspot.create_deal` | hubspot | **auto** | Create the sales Deal keyed by leadId, or adopt the existing one |
| `gmail.send_followup` | gmail | **auto** | Send the follow-up email (Message-ID keyed; timeout reconciles before any retry) |
| `gmail.confirm_lookup` | gmail | **auto** | Confirmation lookup toward unresolved email delivery (three over the window) |
| `calendar.create_followup` | calendar | **auto** | Create the intro Calendar event only after email success is confirmed |
| `slack.notify_complete` | slack | **auto** | Notify the sales channel that follow-up completed |
| `slack.handoff_blocked` | slack | **auto** | Hand off unresolved email (or failed calendar) to a person with instructions |
| `slack.notify_blocked_step` | slack | **auto** | Notify when HubSpot/CRM cannot proceed |

## Providers, credentials and operations

| Provider | Environment | Notes |
|---|---|---|
| hubspot | `HUBSPOT_API_KEY` (private-app token) | Deal natural key is dealname `Lead follow-up <leadId>`. |
| gmail | `GMAIL_API_KEY` (OAuth access token) | Direct send with deterministic Message-ID. |
| calendar | `GOOGLE_CALENDAR_API_KEY` (OAuth access token) | Event private key `acmeKey=<leadId>:followup`. |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to the sales channel. |

**Timers.** Confirmation lookups use durable `delayAfter` timers. A deployed stack should send `{"action":"tick"}` on `rate(1 minute)`; locally, set `TICK_INTERVAL_MS` or send `tick` yourself.

## Setup and run

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=lead-follow-up STATE_FILE=.state/lead-follow-up.json node --env-file=.env dist/main.mjs
```

## FetchSandbox verification

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs lead-follow-up
```

Requires FetchSandbox authentication and managed-relay access. Current measured status, expected-versus-actual outcomes and blockers: [lead-follow-up verification evidence](../evidence/lead-follow-up-verification.md).

### Declared scenarios

See the executable contract [`acme-ops/verify/contracts/lead-follow-up.mjs`](../../acme-ops/verify/contracts/lead-follow-up.mjs). Failed, blocked and unmeasured checks remain visible there and in the evidence file.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/lead-follow-up.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/lead-follow-up.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)
