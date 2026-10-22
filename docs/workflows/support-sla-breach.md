# Support first-response SLA

## Business need

Support leaders need every unanswered ticket chased before its first-response target, breaches surfaced the moment they happen, and enterprise customers escalated to on-call, without duplicate alerts from overlapping sweeps.

Start durable warning and breach timers for every unanswered open ticket from its tier × priority target; warn the assignee at 75%, mark the breach and tell leads at 100%, page on-call for enterprise breaches; each timer re-reads the ticket and fires at most once across overlapping sweeps.

Demo organization: **Acme Corporation**. Department: **Support**. Owning team: **support-ops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "sweepId": "SLA-baseline",
    "scopeTag": "sla_baseline",
    "supportChannel": "C0SUPPORT01",
    "leadsChannel": "C0SUPLEADS1",
    "pagerdutyServiceId": "PSUPP01"
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
| `sweepId` | yes | string |
| `scopeTag` | yes | string |
| `enterpriseTag` | yes | string |
| `supportChannel` | yes | string |
| `leadsChannel` | yes | string |
| `pagerdutyServiceId` | yes | string |
| `agentSlack` | yes | object |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `queue` | zendesk |

**1 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `sla.warn` | zendesk | **auto** | At 75% of target: internal note, tag and Slack warning |
| `sla.breach` | zendesk | **auto** | At target: breach tag, note and leads alert |
| `pagerduty.page` | pagerduty | **auto** | Enterprise breach pages support on-call (de-duplicated) |
| `slack.post_sweep` | slack | **auto** | Sweep summary |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=support-sla-breach STATE_FILE=.state/support-sla-breach.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs support-sla-breach
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A request starts one recorded run (provider-independent, so every later check is measured) | Executable declaration; result comes from a receipt |
| `baseline_effects` | A sweep reads the scoped queue and posts a summary | Executable declaration; result comes from a receipt |
| `unanswered_ticket_timed` | An unanswered open ticket gets warning and breach timers | Executable declaration; result comes from a receipt |
| `enterprise_tier_detected` | A ticket tagged tier_enterprise is timed against the enterprise target and can page | Executable declaration; result comes from a receipt |
| `answered_ticket_not_timed` | A ticket with an agent's public reply has no SLA timer | Executable declaration; result comes from a receipt |
| `pending_ticket_paused` | A ticket waiting on the customer (pending) is not timed | Executable declaration; result comes from a receipt |
| `breach_fires_at_target` | At the target an unanswered ticket is marked breached and leads are told (needs clock control) | Executable declaration; result comes from a receipt |
| `enterprise_breach_pages` | An enterprise breach pages support on-call once (needs clock control) | Executable declaration; result comes from a receipt |
| `zendesk_rate_limited` | When the queue can't be read, support is told timers aren't running | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A malformed PagerDuty service id is rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-support-sla-breach-1.0.0-06c2f09`, verdict **failing**, and statuses: **3 held**, **4 unmeasured**, **3 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/1b1c2cef6e?flow=vr_c92fbe845ccd407b86ac81b3bd23c5da) · [Saved result](../../acme-ops/verify/receipts/support-sla-breach.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/support-sla-breach.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/support-sla-breach.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
