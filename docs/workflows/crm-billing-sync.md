# CRM ↔ billing sync

## Business need

RevOps needs the CRM to show what billing actually charges, without a sync job ever silently overwriting the wrong account or rewriting the whole customer base after an upstream glitch.

Match every Stripe customer in a segment to its HubSpot contact and write the billing-owned fields (plan, MRR, billing status); never overwrite a contact linked to another customer, require approval for runs that would change most of the segment, and cap automatic writes per run.

Demo organization: **Acme Corporation**. Department: **RevOps**. Owning team: **revops-systems**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "syncId": "SYNC-baseline",
    "segment": "cbs-baseline",
    "revopsChannel": "C0REVOPS001"
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
| `syncId` | yes | string |
| `segment` | yes | string |
| `revopsChannel` | yes | string |
| `maxAutoWrites` | yes | integer |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `billing` | stripe |
| `crm-match` | No direct provider requirement; uses input or prior agent results |

**2 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `hubspot.sync` | hubspot | **auto** | Write billing-owned fields (link, plan, MRR, status); approval past the limit or on a mass change |
| `slack.post_sync` | slack | **auto** | Sync summary with conflicts |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| stripe | `STRIPE_API_KEY` (restricted key) | Pinned to Stripe API version `2024-12-18.acacia`; override with `STRIPE_API_VERSION` only after checking the field changes. |
| hubspot | `HUBSPOT_API_KEY` (private-app token) | Custom contact properties must exist before the workflow writes them. |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |

**Set up in the provider accounts first:**

- HubSpot contact properties (single-line text): `acme_stripe_customer_id`, `acme_plan`, `acme_mrr`, `acme_billing_status`.
- Stripe customers in scope carry `metadata.acme_segment` equal to the input `segment`.

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
WORKFLOW=crm-billing-sync STATE_FILE=.state/crm-billing-sync.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs crm-billing-sync
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A segment sync reads billing, matches contacts and posts a summary | Executable declaration; result comes from a receipt |
| `matched_by_email_linked` | A contact found by email is linked to its customer and given plan, MRR and status | Executable declaration; result comes from a receipt |
| `in_sync_not_rewritten` | A contact that already matches billing is not written | Executable declaration; result comes from a receipt |
| `conflict_never_overwritten` | A contact linked to another customer is reported, never overwritten | Executable declaration; result comes from a receipt |
| `unmatched_reported` | A customer with no contact is counted, not created | Executable declaration; result comes from a receipt |
| `auto_limit_respected` | Past the run's automatic limit (1), writes wait for approval | Executable declaration; result comes from a receipt |
| `mass_change_needs_approval` | A run that would change most of the segment at once applies nothing without approval | Executable declaration; result comes from a receipt |
| `stripe_rate_limited` | When billing can't be read nothing is written | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A segment with spaces is rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-crm-billing-sync-1.0.0-befeb35`, verdict **failing**, and statuses: **4 held**, **5 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/0a57cecd9c?flow=vr_2c28915cdd3446b8ade9092aff67beae) · [Saved result](../../acme-ops/verify/receipts/crm-billing-sync.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/crm-billing-sync.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/crm-billing-sync.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
