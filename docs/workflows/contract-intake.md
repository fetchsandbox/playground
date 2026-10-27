# Contract intake and signature

## Business need

Legal needs routine NDAs signed the same day without a lawyer, every deviation reviewed by one, unsigned envelopes cleaned up, and renewal notice dates never missed.

Review an incoming NDA or MSA from Box: a model extracts the clauses, code checks them against the playbook, clean NDAs go to DocuSign directly, deviations and MSAs need a lawyer who isn't the requester; signature is chased and voided after 30 days, and a renewal reminder is set once signed.

Demo organization: **Acme Corporation**. Department: **Legal**. Owning team: **commercial-legal**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "contractId": "CTR-baseline",
    "boxFileId": "1",
    "type": "nda",
    "counterparty": {
      "name": "Northwind",
      "signerName": "Kim Lee",
      "signerEmail": "kim@northwind.example"
    },
    "acmeSigner": {
      "name": "Pat Legal",
      "email": "pat@acme.example"
    },
    "requester": "U_SALES_REP",
    "lawyers": [
      "U_LAWYER",
      "U_SALES_REP"
    ],
    "legalChannel": "C0LEGAL0001"
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
| `contractId` | yes | string |
| `boxFileId` | yes | string |
| `type` | yes | string / nda, msa |
| `counterparty` | yes | object |
| `acmeSigner` | yes | object |
| `requester` | yes | string |
| `lawyers` | yes | array |
| `legalChannel` | yes | string |
| `legalWorkspace` | yes | string |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `clause-extraction` | box, openai |
| `playbook` | No direct provider requirement; uses input or prior agent results |

**2 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `legal.approve` | box | **auto** | Signal: a lawyer who isn't the requester approves the deviations |
| `docusign.send` | docusign | **auto** | Send the Box document for signature (clean NDA directly, otherwise after legal) |
| `docusign.chase` | docusign | **auto** | Resend to unsigned recipients on day 3 and 7 |
| `docusign.void_if_unsigned` | docusign | **auto** | Void the envelope after 30 days unsigned |
| `asana.renewal_reminder` | asana | **auto** | Renewal-notice reminder once signed |
| `slack.post_intake` | slack | **auto** | Intake outcome in the legal channel |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| box | `BOX_API_KEY` (access token) | Uploads go to `upload.box.com`; override with `BOX_UPLOAD_URL` only for a test double. |
| openai | `OPENAI_API_KEY` (+ optional `OPENAI_MODEL`) | Model output is validated in code and never trusted for money or access decisions. |
| docusign | `DOCUSIGN_BASE_URL` (your account's base URI) + `DOCUSIGN_API_KEY` (access token) + `DOCUSIGN_ACCOUNT_ID` |  |
| asana | `ASANA_API_KEY` (personal access token) |  |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |

**Set up in the provider accounts first:**

- A Box file for the contract, an OpenAI key, and a DocuSign account.

**Human decisions (signals).** These steps wait for a named person. Read the waiting action id from `status` (status `awaiting_signal`) and send:

```json
{ "action": "signal", "runId": "<run>", "actionId": "<waiting action id>", "value": "approve", "userId": "<approver id>", "note": "optional" }
```

Senders outside the allowed list, or excluded by segregation-of-duties rules, get HTTP 403.

- `legal.approve`: a lawyer who isn't the requester approves the deviations

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
WORKFLOW=contract-intake STATE_FILE=.state/contract-intake.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs contract-intake
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | An incoming contract is reviewed and the outcome posted to legal | Executable declaration; result comes from a receipt |
| `text_extracted_from_box` | Box provides the document's extracted text | Executable declaration; result comes from a receipt |
| `model_extracts_clauses` | The model returns the NDA's clauses as schema-valid JSON (a standard NDA is clean) | Executable declaration; result comes from a receipt |
| `clean_nda_sent_for_signature` | A clean NDA is sent for signature without a lawyer | Executable declaration; result comes from a receipt |
| `unusable_answer_goes_to_lawyer` | An unusable model answer is never trusted: a lawyer reviews | Executable declaration; result comes from a receipt |
| `requester_cannot_approve` | The person who asked for the contract can't approve its deviations | Executable declaration; result comes from a receipt |
| `msa_lawyer_approval_sends` | A lawyer's approval of an MSA sends it for signature | Executable declaration; result comes from a receipt |
| `unsigned_envelope_voided` | An envelope unsigned after 30 days is voided (needs clock control) | Executable declaration; result comes from a receipt |
| `openai_overloaded_goes_to_lawyer` | When the model is overloaded, a lawyer reviews instead | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A malformed contract id is rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-contract-intake-1.0.0-06c2f09`, verdict **inconclusive**, and statuses: **2 held**, **8 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/b935d80696?flow=vr_1485871a757a4168acda54a07e32ae15) · [Saved result](../../acme-ops/verify/receipts/contract-intake.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/contract-intake.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/contract-intake.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
