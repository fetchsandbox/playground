# Employee offboarding with final pay

## Business need

People Operations needs every departure handled on time: final pay by the work state's legal deadline, access removed at the end of the last day, equipment back, and a rescission undone cleanly.

Offboard an employee on time: file the termination in payroll, pay final wages by the work state's legal deadline (approval, but the law wins), remove access at the end of the last day and verify it, buy equipment return labels, draft the benefits notice; an HR rescission undoes the filed termination.

Demo organization: **Acme Corporation**. Department: **People Operations**. Owning team: **people-ops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "terminationId": "TERM-baseline",
    "employee": {
      "gustoId": "emp_baseline",
      "email": "baseline@acme.example",
      "personalEmail": "home@example.com",
      "workState": "CA",
      "homeAddress": {
        "street1": "1 Elm St",
        "city": "Oakland",
        "state": "CA",
        "zip": "94607",
        "country": "US"
      }
    },
    "type": "involuntary",
    "lastDay": "2026-11-06",
    "nextRegularPayday": "2026-11-13",
    "equipment": [
      {
        "asset": "Laptop",
        "weightOz": 80
      }
    ],
    "hr": [
      "U_HR",
      "U_HRBP"
    ],
    "hrChannel": "C0PEOPLE001",
    "approvers": [
      "U_PAYROLL"
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
| `terminationId` | yes | string |
| `employee` | yes | object |
| `type` | yes | string / voluntary, involuntary |
| `lastDay` | yes | string |
| `nextRegularPayday` | yes | string |
| `workosOrganizations` | yes | array |
| `githubOrg` | no/default | string |
| `equipment` | yes | array |
| `hr` | yes | array |
| `hrChannel` | yes | string |
| `hrWorkspace` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `payroll-record` | gusto |
| `access-inventory` | workos |
| `offboarding-plan` | No direct provider requirement; uses input or prior agent results |

**3 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `gusto.terminate` | gusto | **auto** | File the termination in payroll (undone if HR rescinds) |
| `hr.rescind` | gusto | **auto** | Signal: HR rescinds before the end of the last day |
| `hr.termination_stands` | gusto | **auto** | Saga pivot: a rescission compensates everything filed |
| `gusto.final_payroll` | gusto | **auto** | Final off-cycle payroll; approval by payroll, paid at the deadline regardless |
| `workos.remove` | workos | **auto** | Remove a membership at the end of the last day |
| `github.remove` | github | **auto** | Remove from the GitHub organization at the end of the last day |
| `access.verify_removed` | workos | **auto** | Re-read every system: no access left |
| `easypost.return_label` | easypost | **auto** | Equipment return label from the employee's home |
| `gmail.benefits_notice` | gmail | **auto** | Draft the benefits continuation notice |
| `slack.post_offboarding` | slack | **auto** | HR channel summary with the final-pay deadline |
| `asana.offboarding_record` | asana | **auto** | Record once pay and access removal are settled |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| gusto | `GUSTO_API_KEY` + `GUSTO_COMPANY_ID` | Pinned to `X-Gusto-API-Version: 2026-06-15`; override with `GUSTO_API_VERSION`. |
| workos | `WORKOS_API_KEY` |  |
| github | `GITHUB_API_KEY` (fine-grained token) | Sends `X-GitHub-Api-Version: 2022-11-28`. |
| easypost | `EASYPOST_API_KEY` | HTTP Basic auth. |
| gmail | `GMAIL_API_KEY` (OAuth access token) | Customer mail is created as drafts. |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |
| asana | `ASANA_API_KEY` (personal access token) |  |

**Set up in the provider accounts first:**

- The employee's Gusto, WorkOS and GitHub identities, passed in the input.

**Human decisions (signals).** These steps wait for a named person. Read the waiting action id from `status` (status `awaiting_signal`) and send:

```json
{ "action": "signal", "runId": "<run>", "actionId": "<waiting action id>", "value": "approve", "userId": "<approver id>", "note": "optional" }
```

Senders outside the allowed list, or excluded by segregation-of-duties rules, get HTTP 403.

- `hr.rescind`: HR rescinds before the end of the last day

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
WORKFLOW=employee-offboarding STATE_FILE=.state/employee-offboarding.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs employee-offboarding
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A termination is recorded: final-pay deadline computed from the work state (California dismissal: the last day) and posted to HR | Executable declaration; result comes from a receipt |
| `termination_filed` | The termination is filed in payroll at once | Executable declaration; result comes from a receipt |
| `payroll_approval_pays` | A payroll manager's approval runs the final off-cycle payroll | Executable declaration; result comes from a receipt |
| `deadline_pays_without_approval` | Without approval the final payroll runs four hours before the legal deadline (needs clock control) | Executable declaration; result comes from a receipt |
| `rescission_undoes_termination` | An HR rescission before the last day compensates the filed termination and skips everything else | Executable declaration; result comes from a receipt |
| `access_removed_after_last_day` | At the end of the last day the WorkOS membership is removed and verified (needs clock control) | Executable declaration; result comes from a receipt |
| `late_entry_escalated` | A dismissal entered after its final-pay deadline is flagged late | Executable declaration; result comes from a receipt |
| `workos_unreadable_reported` | When the access inventory fails, HR is told to remove access by hand | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limiting loses the HR post only | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A malformed termination id is rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-employee-offboarding-1.0.0-4ac41d8`, verdict **failing**, and statuses: **5 held**, **5 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/6721b4e193?flow=vr_e0eba42018b34a0abbcc31f78a52085b) · [Saved result](../../acme-ops/verify/receipts/employee-offboarding.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/employee-offboarding.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/employee-offboarding.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
