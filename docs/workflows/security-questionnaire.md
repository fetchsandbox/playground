# Security questionnaire responder

## Business need

IT Security needs to answer from approved material and flag missing answers rather than inventing a compliance claim.

Answer a customer security questionnaire from the approved Notion library, route every unanswered question to Security in Asana and Slack, and draft the response to the customer once Security approves.

Demo organization: **Acme Corporation**. Department: **IT**. Owning team: **it-security**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "customer": {
      "name": "Globex Corporation",
      "email": "baseline@globex.test"
    },
    "questions": [
      {
        "id": "Q1",
        "text": "Do you encrypt customer data at rest and in transit?"
      },
      {
        "id": "Q2",
        "text": "Do you have a current SOC 2 Type II report?"
      },
      {
        "id": "Q3",
        "text": "How do you manage privileged access to production systems?"
      }
    ],
    "libraryDatabaseId": "db_security_answers",
    "securityChannel": "G0PRIVATE01",
    "approvers": [
      "U_CISO"
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
| `customer` | yes | object |
| `questions` | yes | array |
| `libraryDatabaseId` | yes | string |
| `securityChannel` | yes | string |
| `securityWorkspace` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `answer-library` | notion |
| `customer-context` | hubspot |
| `answer-matcher` | No direct provider requirement; uses input or prior agent results |

**3 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `asana.security_review` | asana | **auto** | Open a Security task listing every question without an approved answer |
| `slack.post_summary` | slack | **auto** | Post coverage of the questionnaire to Security |
| `gmail.draft_response` | gmail | **approval** | Draft (not send) the answered questionnaire to the customer |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=security-questionnaire STATE_FILE=.state/security-questionnaire.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs security-questionnaire
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A questionnaire is matched against the library; unanswered questions go to Security and the response draft waits for approval | Executable declaration; result comes from a receipt |
| `approve_and_reconcile` | Approval creates the customer draft; the Security task is read back | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | A non-approver cannot release answers to a customer | Executable declaration; result comes from a receipt |
| `reject` | Rejecting withholds the customer draft | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-delivered questionnaire does not open a second Security task | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four more simultaneous deliveries create one run | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | Duplicate question ids are rejected before anything runs | Executable declaration; result comes from a receipt |
| `notion_auth_failure` | If the answer library can't be read, every question goes to Security and nothing is answered from memory | Executable declaration; result comes from a receipt |
| `asana_rate_limited` | An Asana outage fails the Security task only; the summary still posts | Executable declaration; result comes from a receipt |
| `slack_auth_failure` | A Slack failure loses the summary only | Executable declaration; result comes from a receipt |
| `restart_while_parked` | A response parked for approval survives a runtime restart and is drafted when approved afterwards | Executable declaration; result comes from a receipt |
| `answers_from_library` | Questions that match an approved Notion answer are answered with that exact text | The Notion twin's database query returns generic sample pages without Question/Answer properties, so no question can match the library; the matcher itself is deterministic code (similarity ≥ 0.5). |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-security-questionnaire-1.0.0-df79afd`, verdict **inconclusive**, and statuses: **11 held**, **1 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/ecc2c079f7?flow=vr_e1ca4d13d678473b9992cd1751db6cdf) · [Saved result](../../acme-ops/verify/receipts/security-questionnaire.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/security-questionnaire.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/security-questionnaire.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
