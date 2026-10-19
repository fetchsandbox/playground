# Product change and end-of-life notices

## Business need

Product Engineering needs to identify customers affected by a product change or retirement and coordinate reviewed customer notices.

From an approved product change or end-of-life record in GitHub, find affected customers in Stripe and their owners in HubSpot; post the summary and create owner tasks. Customer notice drafts and marking the record notified wait for approval.

Demo organization: **Acme Corporation**. Department: **Engineering**. Owning team: **product-engineering**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "repo": "acme/plm",
    "productId": "prod_SaaS_ProPlan",
    "kind": "end_of_life",
    "title": "Gen-2 level switch reaches end of life",
    "summary": "The Gen-2 level switch is replaced by Gen-3 (form-fit compatible). Orders after the last-time-buy date ship Gen-3.",
    "effectiveDate": "2027-03-31",
    "lastTimeBuy": "2027-01-31",
    "notifyChannel": "C0GENERAL01",
    "approvers": [
      "U_VP_ENGINEERING"
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
| `repo` | yes | string |
| `issueNumber` | no/default | integer |
| `productId` | yes | string |
| `kind` | yes | string / change, end_of_life |
| `title` | yes | string |
| `summary` | yes | string |
| `effectiveDate` | yes | string |
| `lastTimeBuy` | no/default | string |
| `notifyChannel` | yes | string |
| `asanaWorkspace` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `change-record` | github |
| `affected-customers` | stripe |
| `account-owners` | hubspot, stripe |

**3 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `github.open_change_record` | github | **auto** | Open the change record (issue labelled pcn) when none was given |
| `slack.post_change_summary` | slack | **auto** | Post the change, dates and affected customers |
| `asana.owner_task` | asana | **auto** | Create a follow-up task per account owner |
| `gmail.draft_customer_notice` | gmail | **approval** | Create (not send) the customer notice drafts |
| `github.mark_customers_notified` | github | **approval** | Label the change record customers-notified |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=pcn-eol-notice STATE_FILE=.state/pcn-eol-notice.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs pcn-eol-notice
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | EOL record opened, affected customers posted, owner task created; customer notices and marking the record wait for approval | Executable declaration; result comes from a receipt |
| `approve_and_reconcile` | Approval prepares the notices and labels the record; read-back confirms the label | Executable declaration; result comes from a receipt |
| `unreadable_record_sends_nothing` | If the named change record can't be read, nothing is posted or prepared | Executable declaration; result comes from a receipt |
| `unknown_product_sends_nothing` | An unknown product finds no customers and prepares nothing | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | A non-approver cannot release customer notices | Executable declaration; result comes from a receipt |
| `reject` | Rejecting prepares no customer notices | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A malformed repository name is rejected | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-delivered change does not open a second record | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four more simultaneous deliveries open one record | Executable declaration; result comes from a receipt |
| `github_auth_failure` | GitHub auth failure fails opening the record; internal follow-up continues | Executable declaration; result comes from a receipt |
| `asana_rate_limited` | Asana rate limiting fails the owner task only | Executable declaration; result comes from a receipt |
| `stripe_auth_failure` | Without Stripe the affected customers are unknown, so nothing is prepared | Executable declaration; result comes from a receipt |
| `restart_while_parked` | A pending notice run survives a real runtime restart and completes when approved afterwards | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-pcn-eol-notice-1.0.0-7e9260e`, verdict **verified**, and statuses: **13 held**.

[Recorded receipt](https://fetchsandbox.com/runs/f58e5f23dc?flow=vr_851466eb937c45e282a501a9e2697d6c) · [Saved result](../../acme-ops/verify/receipts/pcn-eol-notice.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/pcn-eol-notice.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/pcn-eol-notice.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
