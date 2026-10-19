# Compliance documents on request

## Business need

Quality needs to answer product-document requests using the approved library, and route missing evidence to a person before sharing externally.

Answer a customer's request for compliance documents: validate the part, look the documents up in the Box library and draft the reply. Sharing a document externally waits for approval; anything missing goes to Quality as an Asana task with a holding reply.

Demo organization: **Acme Corporation**. Department: **Quality**. Owning team: **quality-compliance**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "requester": {
      "email": "alice@acmecorp.com",
      "name": "Alice Johnson"
    },
    "product": "Pro Plan",
    "docTypes": [
      "rohs",
      "coc"
    ],
    "qualityChannel": "C0GENERAL01"
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
| `requester` | yes | object |
| `product` | yes | string |
| `docTypes` | yes | array |
| `qualityChannel` | yes | string |
| `qualityWorkspace` | yes | string |
| `libraryFolderId` | yes | string |
| `linkExpiryDays` | yes | integer |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `part-check` | stripe |
| `requester-context` | hubspot |
| `document-library` | stripe, box |
| `reply-composer` | No direct provider requirement; uses input or prior agent results |

**4 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `slack.post_request` | slack | **auto** | Post the request to the Quality channel |
| `asana.request_documents` | asana | **auto** | Ask Quality to prepare missing documents |
| `gmail.draft_holding_reply` | gmail | **auto** | Create (not send) a holding reply while documents are prepared |
| `box.share_document` | box | **approval** | Create an expiring external Box link to a released document |
| `gmail.draft_documents` | gmail | **approval** | Create (not send) the reply carrying the document links |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=compliance-docs STATE_FILE=.state/compliance-docs.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs compliance-docs
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | Documents not in the library are routed to Quality with a holding reply; nothing is shared | Executable declaration; result comes from a receipt |
| `unknown_part_no_reply` | A request for an unknown part gets no customer reply, only a Quality review note | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-delivered request opens one Quality task | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four more simultaneous deliveries open one Quality task | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A request naming no documents is rejected before any agent runs | Executable declaration; result comes from a receipt |
| `box_auth_failure` | If the Box library can't be searched, the request still reaches Quality (flagged) instead of claiming documents are missing | Executable declaration; result comes from a receipt |
| `asana_rate_limited` | Asana rate limiting fails the Quality task only; the holding reply is still drafted | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limiting fails the channel post only | Executable declaration; result comes from a receipt |
| `restart_then_redelivery` | After a runtime restart, a re-delivered request finds the saved run and repeats nothing | Executable declaration; result comes from a receipt |
| `box_document_share_gated` | A released document found in Box is shared by an expiring link only after approval, then sent in a drafted reply | The Box twin has no seeded files and its search returns sample data, so the found-document path (gated box.share_document + gmail.draft_documents) is never reached; matchDoc() is covered by local reasoning only. |
| `zendesk_ticket_reply` | The reply is posted on the customer's Zendesk ticket | FetchSandbox has no Zendesk twin yet; replies are Gmail drafts. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-compliance-docs-1.0.0-0908aa5`, verdict **inconclusive**, and statuses: **9 held**, **2 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/793bb8daac?flow=vr_89a3a67d17bd49e393bbd879dacefcce) · [Saved result](../../acme-ops/verify/receipts/compliance-docs.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/compliance-docs.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/compliance-docs.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
