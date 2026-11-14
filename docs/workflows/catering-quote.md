# Catering quote to booking

## Business need

A restaurant owner (for example a pizza shop) needs every catering request answered quickly with a correct per-head quote, negotiated within limits, approved by the owner before the customer hears anything, and once accepted turned into a calendar booking, an invoice, clear follow-up instructions and a day-before reminder, exactly once.

A catering request (email, text or ad lead) is priced per head in code, negotiated down to a floor, and quoted only after the owner approves. The latest quote, once the customer accepts, books the owner's calendar, sends a Stripe invoice due 72 h before the event, confirms with follow-up instructions, and reminds the customer a day before.

Demo organization: **Acme Corporation**. Department: **Restaurant Operations**. Owning team: **catering**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "inquiryId": "CAT-base-{{run_id}}",
    "revision": 1,
    "source": "email",
    "customer": {
      "name": "Dana Rivera",
      "email": "base@party.example.test",
      "phone": "+1 555 0100"
    },
    "event": {
      "start": "2026-10-25T18:00:00.000Z",
      "durationMinutes": 120,
      "headcount": 30,
      "fulfillment": "delivery",
      "address": "12 Elm St, Springfield"
    },
    "package": "classic",
    "owner": {
      "name": "Tony's Pizza",
      "email": "owner@tonys-pizza.example.test",
      "phone": "+1 555 0199",
      "calendarId": "primary",
      "timeZone": "America/New_York"
    },
    "approvers": [
      "U_OWNER_TONY"
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
| `inquiryId` | yes | string |
| `revision` | yes | integer |
| `source` | yes | string / email, sms, ad_form, web_form, phone |
| `customer` | yes | object |
| `event` | yes | object |
| `package` | yes | string / classic, premium |
| `requestedPerHeadMinor` | no/default | integer |
| `owner` | yes | object |
| `approvers` | yes | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `crm-lookup` | hubspot |
| `availability` | calendar |
| `billing-lookup` | stripe |
| `quote-desk` | No direct provider requirement; uses input or prior agent results |

**4 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `hubspot.upsert_contact` | hubspot | **auto** | Create/update the customer contact (opportunity when quoted; never downgraded) |
| `gmail.send_quote` | gmail | **approval** | Send the per-head quote once the owner approves it |
| `stripe.record_quote` | stripe | **auto** | Find or create the Stripe customer and mark this revision as the one that can be accepted |
| `quote.customer_acceptance` | stripe | **auto** | Signal: the customer (via the inbox adapter) or the owner accepts the latest quote before it expires |
| `calendar.book_event` | calendar | **auto** | Book the event on the owner's catering calendar with day-before and 2-hour reminders |
| `stripe.send_invoice` | stripe | **auto** | Create, finalize and send the Stripe invoice, due 72 h before the event |
| `gmail.send_confirmation` | gmail | **auto** | Confirm the booking with invoice and follow-up instructions (final count, day-of call) |
| `hubspot.mark_customer` | hubspot | **auto** | Mark the contact a customer |
| `gmail.send_reminder` | gmail | **auto** | Remind the customer the day before (skipped if the event or invoice was cancelled) |
| `gmail.send_decline` | gmail | **approval** | Send a polite decline once the owner approves it |
| `gmail.notify_owner` | gmail | **auto** | Tell the owner a request needs them (large party, too many rounds, systems unavailable) |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| hubspot | `HUBSPOT_API_KEY` (private-app token) | Custom contact properties must exist before the workflow writes them. |
| calendar | `GOOGLE_CALENDAR_API_KEY` (OAuth access token) |  |
| stripe | `STRIPE_API_KEY` (restricted key) | Pinned to Stripe API version `2024-12-18.acacia`; override with `STRIPE_API_VERSION` only after checking the field changes. |
| gmail | `GMAIL_API_KEY` (OAuth access token) | Needs the `gmail.send` scope. Messages are sent (not drafted) only by the actions marked `gmail.send_*`, after their gates; each carries a deterministic Message-ID used to recover a lost send without resending. |

**Set up in the provider accounts first:**

- A Google Calendar the owner uses for catering (input `owner.calendarId`); existing bookings on it block overlapping requests.
- An inbox/SMS intake adapter that calls `start` for each request or counter-offer (runId = `<inquiryId>-r<revision>`) and `signal` on `quote.customer_acceptance` with userId `inbox:customer-reply` when the customer accepts or declines.
- Stripe invoice emails enabled in the Stripe dashboard (Settings → Customer emails) so `/send` actually emails the customer.

**Human decisions (signals).** These steps wait for a named person. Read the waiting action id from `status` (status `awaiting_signal`) and send:

```json
{ "action": "signal", "runId": "<run>", "actionId": "<waiting action id>", "value": "approve", "userId": "<approver id>", "note": "optional" }
```

Senders outside the allowed list, or excluded by segregation-of-duties rules, get HTTP 403.

- `quote.customer_acceptance`: the customer (via the inbox adapter) or the owner accepts the latest quote before it expires

**Timers.** Reminders, deadlines and follow-ups are durable timers. A deployed stack sends `{"action":"tick"}` on the schedule `rate(15 minutes)` (EventBridge Scheduler); locally, set `TICK_INTERVAL_MS` or send `tick` yourself.

**Audit trail.** Every decision, signal and effect is hash-chained. `{"action":"evidence","runId":"<run>"}` returns the trail and whether the chain verifies.

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=catering-quote STATE_FILE=.state/catering-quote.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs catering-quote
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A 30-guest delivery request is quoted at $18/head + $35 delivery, sent after the owner approves, and once the customer accepts: calendar booked, Stripe invoice sent, confirmation sent, CRM customer, day-before reminder scheduled | Executable declaration; result comes from a receipt |
| `stranger_cannot_approve` | Someone who isn't an approver can't release a quote: it stays parked and nothing is booked | Executable declaration; result comes from a receipt |
| `owner_rejects_quote` | The owner rejects the quote: nothing is sent, booked or invoiced | Executable declaration; result comes from a receipt |
| `customer_declines` | The customer says no: no booking, invoice, confirmation or reminder, and the run closes | Executable declaration; result comes from a receipt |
| `stranger_cannot_accept` | Only the customer's relayed reply or the owner can accept a quote | Executable declaration; result comes from a receipt |
| `accept_before_quote_sent_ignored` | An acceptance recorded before the owner approved the quote doesn't book anything | Executable declaration; result comes from a receipt |
| `negotiated_within_floor` | A counter-offer of $16/head (floor $15.30) is honoured, and the invoice is for the negotiated total | Executable declaration; result comes from a receipt |
| `counter_below_floor_countered` | A counter-offer of $12/head is countered at the $15.30 floor, not accepted | Executable declaration; result comes from a receipt |
| `superseded_revision_not_accepted` | After a revised quote is sent, accepting the old revision books nothing; accepting the new one books once at the new price | Executable declaration; result comes from a receipt |
| `booked_inquiry_not_requoted` | Once a quote is accepted, a later counter-offer on the same inquiry goes to the owner instead of a second quote | Executable declaration; result comes from a receipt |
| `headcount_below_minimum_declined` | A 6-guest request is declined (minimum 10); the decline waits for the owner | Executable declaration; result comes from a receipt |
| `short_notice_declined` | A request for 20 hours from now is declined (48 h lead time) | Executable declaration; result comes from a receipt |
| `date_conflict_declined` | A slot the kitchen is already booked for is declined, and the owner-approved decline is sent | Executable declaration; result comes from a receipt |
| `large_party_to_owner` | A 200-guest request goes to the owner; the customer gets nothing automatic | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A delivery request without an address is rejected before any agent runs | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-delivered request is one run; its CRM write, quote and Stripe record happen once | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four simultaneous re-deliveries of a request create one run, one CRM write and one parked quote | Executable declaration; result comes from a receipt |
| `concurrent_acceptance` | Four simultaneous acceptances book the calendar once and send one invoice | Executable declaration; result comes from a receipt |
| `gmail_send_rejected_then_resumed` | Gmail refuses the approved quote: nothing downstream happens; after Gmail recovers, resume sends it once and the quote can be accepted | Executable declaration; result comes from a receipt |
| `gmail_response_lost_recovered` | Gmail accepts the quote but the response is lost: the app finds the sent message by Message-ID and records it, without sending a second email | Executable declaration; result comes from a receipt |
| `gmail_lookup_unavailable_not_resent` | Gmail's response is lost AND the mailbox lookup is down: the send is marked uncertain and not resent | Executable declaration; result comes from a receipt |
| `calendar_unavailable_to_owner` | The calendar can't be read: no date is promised; the owner is told | Executable declaration; result comes from a receipt |
| `stripe_unavailable_to_owner` | Billing can't be read: the request goes to the owner instead of a quote that might double-book | Executable declaration; result comes from a receipt |
| `hubspot_down_quote_continues` | A HubSpot auth failure skips the CRM update; the quote still waits for the owner | Executable declaration; result comes from a receipt |
| `restart_awaiting_acceptance` | A sent quote waiting for the customer survives a runtime restart and books once when accepted | Executable declaration; result comes from a receipt |
| `booking_reconciled_reminder_not_early` | After booking, the calendar event and invoice read back as written, and a tick doesn't send the reminder before the day before | Executable declaration; result comes from a receipt |
| `reminder_sent_day_before` | The customer reminder is sent 24 h before the event (and skipped if the event or invoice was cancelled) | The reminder fires at event − 24 h, at least a day after booking; the runtime's timers use the real clock and the verifier's execution budget is under an hour, so the send can't be observed in a twin run. It is exercised with a controlled clock in acme-ops/test/catering-quote.test.ts; here the check above only proves it is scheduled for the right time and not sent early. |
| `quote_expires_unaccepted` | An unanswered quote expires after 7 days (or 48 h before the event) and nothing is booked | Expiry is a signal deadline days after sending; it needs the runtime's clock to advance, which a twin run can't do. Covered with a controlled clock in acme-ops/test/catering-quote.test.ts. |
| `inbound_reply_starts_or_accepts` | A customer's email/SMS reply is parsed into a new revision or an acceptance signal | Reply parsing belongs to the inbox intake adapter, outside this runtime (which takes the parsed request or signal). The Gmail twin does not simulate users.history or users.watch, so mailbox-driven intake can't be exercised here. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-catering-quote-1.0.0-7aa9614`, verdict **inconclusive**, and statuses: **25 held**, **4 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/86863f3bc0?flow=vr_6d113a8a1bd84198bc1280c1e457bacc) · [Saved result](../../acme-ops/verify/receipts/catering-quote.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/catering-quote.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/catering-quote.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)


See the [catering business design, industry pattern and measured evidence](catering-quote-design.md).

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
