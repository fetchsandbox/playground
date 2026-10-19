# Incident communications

## Business need

IT Operations needs to identify affected customers and keep responders informed without sending an unreviewed outage statement.

On a PagerDuty incident: find the customers on the affected service, post the war-room update, record a timeline note on the incident, and draft customer notices (outage or resolution) for approval. Low-urgency incidents stay internal.

Demo organization: **Acme Corporation**. Department: **IT**. Owning team: **it-operations**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "incident": {
      "id": "PBASELINE",
      "title": "Monitoring API returning 503",
      "service": "ACME Cloud Monitoring",
      "urgency": "high",
      "status": "triggered"
    },
    "warRoomChannel": "C0INCIDENT",
    "approvers": [
      "U_INCIDENT_CMDR"
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
| `incident` | yes | object |
| `affectedProductIds` | yes | array |
| `warRoomChannel` | yes | string |
| `maxNotices` | yes | integer |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `customer-impact` | stripe |
| `account-owners` | hubspot |

**2 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `slack.war_room_update` | slack | **auto** | Post status and impact to the war-room channel |
| `pagerduty.timeline_note` | pagerduty | **auto** | Record the comms status as a note on the incident |
| `gmail.draft_customer_notice` | gmail | **approval** | Draft (not send) an outage or resolution notice per affected customer |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=incident-comms STATE_FILE=.state/incident-comms.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs incident-comms
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A high-urgency incident updates the war room and the incident timeline, and drafts a notice per affected customer for approval | Executable declaration; result comes from a receipt |
| `low_urgency_internal` | A low-urgency incident stays internal: no customer notices | Executable declaration; result comes from a receipt |
| `resolution_notices` | A resolved incident drafts resolution notices for approval | Executable declaration; result comes from a receipt |
| `approve_by_commander` | The incident commander's approval creates the customer drafts | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | Someone outside the incident cannot release customer notices | Executable declaration; result comes from a receipt |
| `reject` | Rejecting withholds every customer notice | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-delivered PagerDuty webhook does not post twice | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four more simultaneous webhook deliveries create one run | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A malformed incident id is rejected before anything runs | Executable declaration; result comes from a receipt |
| `stripe_auth_failure` | If billing can't be read, the war room hears 'impact unknown' and no customer is notified | Executable declaration; result comes from a receipt |
| `hubspot_rate_limited` | Losing CRM owners doesn't stop customer notices | Executable declaration; result comes from a receipt |
| `slack_auth_failure` | A Slack failure loses the war-room post only | Executable declaration; result comes from a receipt |
| `pagerduty_rate_limited` | A PagerDuty failure loses the timeline note only | Executable declaration; result comes from a receipt |
| `restart_while_parked` | Notices parked for approval survive a runtime restart and are drafted when approved afterwards | Executable declaration; result comes from a receipt |
| `status_page_update` | The public status page is updated with the incident | There is no Statuspage (or equivalent) twin; the runtime does not write to a status page. |
| `affected_by_product` | Only customers on the affected products are notified | Seeded Stripe twin subscription items carry no price/product, so a product-scoped incident matches nobody; service-wide incidents are proven instead. |
| `pagerduty_note_readback` | The timeline note is read back from the incident | The PagerDuty twin's GET /incidents/{id}/notes returns sample notes rather than the note written. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-incident-comms-1.0.0-df79afd`, verdict **inconclusive**, and statuses: **14 held**, **3 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/dca8a1db6f?flow=vr_76c83c422ebc495b89d551339b6b736c) · [Saved result](../../acme-ops/verify/receipts/incident-comms.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/incident-comms.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/incident-comms.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
