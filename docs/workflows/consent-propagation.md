# Consent change propagation

## Business need

Marketing and privacy must honour an opt-out everywhere it is used, never let a delayed event undo a newer choice, and prove the change took effect in every system.

Apply a consent change (marketing email, sale or sharing of data, profiling) to HubSpot (contact property and email subscription) and every Stripe customer with that email, guarded by the event time so stale events never win; read every system back after 15 minutes, re-apply once and escalate a persistent mismatch.

Demo organization: **Acme Corporation**. Department: **Marketing**. Owning team: **marketing-ops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "eventId": "evt_baseline",
    "email": "consent-baseline@pref.example",
    "occurredAt": "2026-10-22T12:00:00.000Z",
    "source": "preference_center",
    "changes": [
      {
        "purpose": "marketing_email",
        "state": "withdrawn"
      },
      {
        "purpose": "sale_or_share",
        "state": "withdrawn"
      }
    ],
    "marketingSubscriptionId": "4242",
    "privacyChannel": "C0PRIVACY01"
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
| `email` | yes | string |
| `occurredAt` | yes | string |
| `source` | yes | string / preference_center, unsubscribe_link, support_request, gpc_signal |
| `changes` | yes | array |
| `marketingSubscriptionId` | yes | string |
| `privacyChannel` | yes | string |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `crm` | hubspot |
| `subscriptions` | hubspot |
| `billing` | stripe |

**3 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `hubspot.consent` | hubspot | **auto** | Consent property per purpose, guarded by event time |
| `hubspot.subscription` | hubspot | **auto** | Marketing email subscription on or off |
| `stripe.consent` | stripe | **auto** | Consent metadata on every customer with the address |
| `slack.post_consent` | slack | **auto** | A system could not be read, or nothing holds the address |
| `consent.verify` | hubspot | **auto** | Read every system back after 15 minutes; re-apply once; escalate a mismatch |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| hubspot | `HUBSPOT_API_KEY` (private-app token) | Custom contact properties must exist before the workflow writes them. |
| stripe | `STRIPE_API_KEY` (restricted key) | Pinned to Stripe API version `2024-12-18.acacia`; override with `STRIPE_API_VERSION` only after checking the field changes. |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |

**Set up in the provider accounts first:**

- HubSpot contact properties (single-line text): `acme_consent_marketing_email`, `acme_consent_sale_or_share`, `acme_consent_profiling`, `acme_consent_last_event`.
- A HubSpot email subscription type for marketing; its id is the input `marketingSubscriptionId`.

**Timers.** Reminders, deadlines and follow-ups are durable timers. A deployed stack sends `{"action":"tick"}` on the schedule `rate(5 minutes)` (EventBridge Scheduler); locally, set `TICK_INTERVAL_MS` or send `tick` yourself.

**Audit trail.** Every decision, signal and effect is hash-chained. `{"action":"evidence","runId":"<run>"}` returns the trail and whether the chain verifies.

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=consent-propagation STATE_FILE=.state/consent-propagation.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs consent-propagation
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A request starts one recorded run (provider-independent, so every later check is measured) | Executable declaration; result comes from a receipt |
| `baseline_effects` | A withdrawal is written to the HubSpot contact with its event time | Executable declaration; result comes from a receipt |
| `subscription_turned_off` | Marketing email withdrawal unsubscribes the address in HubSpot | Executable declaration; result comes from a receipt |
| `every_customer_updated` | Every Stripe customer with the address carries the withdrawal | Executable declaration; result comes from a receipt |
| `stale_event_ignored` | An event older than the consent on record changes nothing | Executable declaration; result comes from a receipt |
| `replay_changes_nothing` | The same event delivered again writes nothing | Executable declaration; result comes from a receipt |
| `verified_after_15_minutes` | Fifteen minutes later every system is read back and agrees (needs clock control) | Executable declaration; result comes from a receipt |
| `hubspot_rate_limited` | When HubSpot can't be read, billing is still updated and privacy-ops is told | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | An unknown purpose is rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-consent-propagation-1.0.0-befeb35`, verdict **failing**, and statuses: **4 held**, **1 unmeasured**, **4 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/6d12a62768?flow=vr_d6428dde89434b3096ac24e1ffe115a0) · [Saved result](../../acme-ops/verify/receipts/consent-propagation.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/consent-propagation.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/consent-propagation.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
