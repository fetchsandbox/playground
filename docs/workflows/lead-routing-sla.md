# Lead routing with first-touch SLA

## Business need

Sales needs every inbound lead in front of the right rep within minutes, fairly distributed, with untouched leads reassigned automatically instead of going cold.

Route an inbound HubSpot lead to its account owner or the least-loaded rep of its territory pod, DM the rep, and enforce the first-touch SLA with a durable timer: an untouched lead is reassigned and the manager told, a second miss escalates.

Demo organization: **Acme Corporation**. Department: **Sales**. Owning team: **revops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "contactId": "80001488064692",
    "pods": {
      "NA": {
        "enterprise": {
          "reps": [
            {
              "ownerId": "11",
              "slackId": "U_REP_11"
            },
            {
              "ownerId": "12",
              "slackId": "U_REP_12"
            }
          ],
          "managerSlackId": "U_MGR_NA_ENT"
        },
        "commercial": {
          "reps": [
            {
              "ownerId": "21",
              "slackId": "U_REP_21"
            },
            {
              "ownerId": "22",
              "slackId": "U_REP_22"
            },
            {
              "ownerId": "23",
              "slackId": "U_REP_23"
            }
          ],
          "managerSlackId": "U_MGR_NA_COM"
        }
      },
      "EMEA": {
        "enterprise": {
          "reps": [
            {
              "ownerId": "31",
              "slackId": "U_REP_31"
            }
          ],
          "managerSlackId": "U_MGR_EMEA_ENT"
        },
        "commercial": {
          "reps": [
            {
              "ownerId": "41",
              "slackId": "U_REP_41"
            },
            {
              "ownerId": "42",
              "slackId": "U_REP_42"
            }
          ],
          "managerSlackId": "U_MGR_EMEA_COM"
        }
      },
      "APAC": {
        "enterprise": {
          "reps": [
            {
              "ownerId": "51",
              "slackId": "U_REP_51"
            }
          ],
          "managerSlackId": "U_MGR_APAC"
        },
        "commercial": {
          "reps": [
            {
              "ownerId": "61",
              "slackId": "U_REP_61"
            }
          ],
          "managerSlackId": "U_MGR_APAC"
        }
      }
    },
    "regions": {
      "DE": "EMEA",
      "FR": "EMEA",
      "JP": "APAC"
    },
    "salesChannel": "C0SALES0001"
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
| `contactId` | yes | string |
| `pods` | yes | object |
| `regions` | yes | object |
| `salesChannel` | yes | string |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `lead` | hubspot |
| `workloads` | hubspot |
| `routing` | No direct provider requirement; uses input or prior agent results |

**3 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `hubspot.assign` | hubspot | **auto** | Assign the owner (unless someone claimed the lead meanwhile) and DM the rep |
| `sla.first_touch` | hubspot | **auto** | At the SLA: an untouched lead is reassigned to the backup rep and the manager told |
| `sla.escalate` | hubspot | **auto** | A second miss escalates to the manager |
| `slack.post_routing` | slack | **auto** | Blocked or already-owned leads posted to sales |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| hubspot | `HUBSPOT_API_KEY` (private-app token) | Custom contact properties must exist before the workflow writes them. |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |

**Set up in the provider accounts first:**

- HubSpot owners listed as reps in the input pods. Leads use the standard properties `country`, `numberofemployees` and `hs_email_domain`.

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
WORKFLOW=lead-routing-sla STATE_FILE=.state/lead-routing-sla.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs lead-routing-sla
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | An inbound lead is read and routed to a rep of its territory pod | Executable declaration; result comes from a receipt |
| `least_loaded_rep_assigned` | The rep with fewer open new leads gets it | Executable declaration; result comes from a receipt |
| `enterprise_lead_one_hour_sla` | A 5,000-employee US lead goes to the NA enterprise pod with a 60-minute SLA | Executable declaration; result comes from a receipt |
| `account_owner_wins` | A lead from a company we already work with goes to that account's owner | Executable declaration; result comes from a receipt |
| `owned_lead_not_rerouted` | A lead that already has an owner is not re-routed | Executable declaration; result comes from a receipt |
| `missed_sla_reassigns` | A lead untouched at the SLA is reassigned to the backup rep (needs clock control) | Executable declaration; result comes from a receipt |
| `hubspot_unreadable_blocks` | When HubSpot can't be read nothing is assigned and sales is told | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limiting loses the DM only; the lead is still assigned | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A malformed contact id is rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-lead-routing-sla-1.0.0-befeb35`, verdict **failing**, and statuses: **7 held**, **2 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/7657f560d2?flow=vr_ec298074bb2e40a9906d9d41a2a32090) · [Saved result](../../acme-ops/verify/receipts/lead-routing-sla.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/lead-routing-sla.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/lead-routing-sla.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
