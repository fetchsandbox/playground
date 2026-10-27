# Purchase request to purchase order

## Business need

Finance needs every purchase approved by the right people for its amount and budget, never by the requester, with a purchase order raised exactly once and nothing bought from a held or sanctioned vendor.

Check a purchase request's vendor, budget, duplicates and sanctions in parallel, route it through the delegation-of-authority chain (manager, finance, VP, CFO by amount; finance whenever over budget) with no self- or repeat approval, remind and lapse slow approvers, then raise the NetSuite purchase order exactly once and tell the requester.

Demo organization: **Acme Corporation**. Department: **Finance**. Owning team: **procurement**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "requestId": "PR-baseline",
    "requester": "U_REQ",
    "vendorId": "301",
    "description": "Load-testing service, 12 months",
    "amount": 1200000,
    "currency": "usd",
    "department": {
      "id": "7",
      "name": "Engineering",
      "annualBudget": 10000000
    },
    "expenseAccount": "6100",
    "approvers": {
      "manager": [
        "U_MGR",
        "U_REQ"
      ],
      "finance": [
        "U_FIN",
        "U_MGR"
      ],
      "vp": [
        "U_VP"
      ],
      "cfo": [
        "U_CFO"
      ]
    },
    "procurementChannel": "C0PROCURE01"
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
| `requester` | yes | string |
| `vendorId` | yes | string |
| `description` | yes | string |
| `amount` | yes | integer |
| `currency` | yes | string / usd, eur, gbp |
| `department` | yes | object |
| `expenseAccount` | yes | string |
| `approvers` | yes | object |
| `procurementChannel` | yes | string |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `vendor` | netsuite |
| `budget` | netsuite |
| `duplicates` | netsuite |
| `screening` | netsuite, screening |

**4 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `slack.post_stopped` | slack | **auto** | Vendor inactive, on hold, sanctioned or unreadable: nothing is approved |
| `slack.post_request` | slack | **auto** | Request, approval chain, budget and duplicate warning |
| `approve.manager` | slack | **auto** | Signal: requester's manager |
| `approve.finance` | slack | **auto** | Signal: finance (over 5,000 or over budget) |
| `approve.vp` | slack | **auto** | Signal: VP (over 50,000) |
| `approve.cfo` | slack | **auto** | Signal: CFO (over 250,000) |
| `slack.remind` | slack | **auto** | Reminder to the pending approver after 3 days |
| `netsuite.create_po` | netsuite | **auto** | Purchase order, once per request |
| `slack.dm_requester` | slack | **auto** | PO number, or why there is none |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| netsuite | `NETSUITE_BASE_URL` (`https://<account>.suitetalk.api.netsuite.com`) + `NETSUITE_API_KEY` (OAuth 2.0 access token) | Tokens expire after 60 minutes; refresh them outside the runtime. |
| screening | `TRADE_GOV_API_KEY` (developer.trade.gov subscription key) | Sent as the `subscription-key` header. |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |

**Set up in the provider accounts first:**

- NetSuite vendor custom fields `custentity_acme_payment_hold` (checkbox) and `custentity_acme_hold_reason`.
- Department budgets come from your planning system through the input.

**Human decisions (signals).** These steps wait for a named person. Read the waiting action id from `status` (status `awaiting_signal`) and send:

```json
{ "action": "signal", "runId": "<run>", "actionId": "<waiting action id>", "value": "approve", "userId": "<approver id>", "note": "optional" }
```

Senders outside the allowed list, or excluded by segregation-of-duties rules, get HTTP 403.

- `approve.manager`: requester's manager
- `approve.finance`: finance (over 5,000 or over budget)
- `approve.vp`: VP (over 50,000)
- `approve.cfo`: CFO (over 250,000)

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
WORKFLOW=purchase-request-to-po STATE_FILE=.state/purchase-request-to-po.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs purchase-request-to-po
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A request starts one recorded run (provider-independent, so every later check is measured) | Executable declaration; result comes from a receipt |
| `baseline_effects` | A purchase request is announced to procurement with its approval chain | Executable declaration; result comes from a receipt |
| `vendor_and_budget_read` | Vendor status, committed spend, duplicates and sanctions are read before any approval | Executable declaration; result comes from a receipt |
| `chain_by_amount` | A 12,000 request needs the manager, then finance | Executable declaration; result comes from a receipt |
| `requester_cannot_approve` | The requester can't approve their own request | Executable declaration; result comes from a receipt |
| `no_repeat_approver` | Someone who approved as manager can't also approve as finance | Executable declaration; result comes from a receipt |
| `approved_po_raised_once` | After the full chain approves, one purchase order is raised in the ERP | Executable declaration; result comes from a receipt |
| `slow_approval_lapses` | An approval unanswered for 7 days lapses and no PO is raised (needs clock control) | Executable declaration; result comes from a receipt |
| `erp_unavailable_stops` | When the ERP can't be read nothing is approved and procurement is told | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A negative amount is rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-purchase-request-to-po-1.0.0-06c2f09`, verdict **failing**, and statuses: **2 held**, **4 unmeasured**, **4 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/f872e53438?flow=vr_a1f6960b9f7947978738aa94c733d7ba) · [Saved result](../../acme-ops/verify/receipts/purchase-request-to-po.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/purchase-request-to-po.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/purchase-request-to-po.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
