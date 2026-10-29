# Signed agreement filing

## Business need

Legal needs every signed agreement in the company's document store, in the right folder, the day it is signed, without anyone downloading PDFs from DocuSign, and needs unrecognized or uncountersigned documents caught for review instead of misfiled.

When a DocuSign envelope completes, file the signed PDF (with its certificate of completion) in Box or Dropbox in the folder its agreement type calls for and tell the owning team; unrecognized types and missing countersignatures go to a review folder for Legal; idempotent by envelope id, never overwrites; folders, naming, types and channels are policy.

Demo organization: **Acme Corporation**. Department: **Legal**. Owning team: **contract-ops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "envelopeId": "3f1c2b7a-5d4e-4c3b-9a8f-7e6d5c4b3a21"
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
| `envelopeId` | yes | string |
| `event` | yes | string |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `envelope` | docusign |

**1 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `storage.file_signed` | box | **auto** | File the signed PDF and certificate in the policy's store (Box or Dropbox) and folder; never overwrites |
| `slack.notify_filed` | slack | **auto** | Tell the type's channel where it is filed, or Legal why it needs review |
| `slack.post_filing_failed` | slack | **auto** | The store refused the document: Legal is told it is still only in DocuSign |
| `slack.post_unreadable` | slack | **auto** | Envelope unreadable: nothing filed, Legal told |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| docusign | `DOCUSIGN_BASE_URL` (your account's base URI) + `DOCUSIGN_API_KEY` (access token) + `DOCUSIGN_ACCOUNT_ID` |  |
| box | `BOX_API_KEY` (access token) | Uploads go to `upload.box.com`; override with `BOX_UPLOAD_URL` only for a test double. |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |

**Set up in the provider accounts first:**

- A DocuSign Connect configuration (or a daily sweep of completed envelopes) that calls `start` with the envelope id; use `ds-<envelopeId>` as the run id.
- Envelope custom fields `agreement_type` and `counterparty` set by your templates or senders (or form fields with those labels); otherwise the subject rules in the policy classify the envelope.
- A Box folder id or Dropbox path as the policy's store root; the integration needs write access below it. Slack channels named in the policy, with the bot invited.

**Audit trail.** Every decision, signal and effect is hash-chained. `{"action":"evidence","runId":"<run>"}` returns the trail and whether the chain verifies.

## Configurable policy

Every limit, deadline, routing rule and folder layout lives in [`acme-ops/policies/signed-agreement-filing.json`](../../acme-ops/policies/signed-agreement-filing.json), not in the code. The workflow validates it at startup against its schema and refuses to start on an invalid value. Each run records the policy version it started under and keeps it until it finishes.

Override per deployment without a code change: `POLICY_FILE=/path/override.json` (a mounted file) and/or `POLICY_JSON='{...}'` (an environment value or secret). Objects merge key by key; lists and values replace. On AWS: `cdk deploy -c policyFile:<workflow>=override.json`. `{"action":"describe"}` returns the effective values, their version and the JSON Schema.

| Setting | Default | Meaning |
|---|---|---|
| `store` |  | Where documents are filed |
| `store.provider` | `"box"` | Document store: box or dropbox |
| `store.root` | `"0"` | Box: the root folder id ("0" is All Files). Dropbox: a path such as "/Acme" ("" is the account or team root) |
| `internalDomains` | `["acme.example"]` | Email domains of your own signers (countersignature check, counterparty detection) |
| `legalChannel` | `"C0LEGAL0001"` | Slack channel for failures (envelope unreadable, store unavailable) |
| `classification` |  | How an envelope's agreement type is recognized |
| `classification.customField` | `"agreement_type"` | Envelope custom field holding the agreement type (set by your templates or sender) |
| `classification.formField` | `"agreement_type"` | Form field (tab label) holding the agreement type |
| `classification.subjectRules` | `[{"pattern": "\\b(NDA\|non-disclosure\|confidentiality agreement)\\b", "type": "NDA"}, {"pattern": "\\b(DPA\|data processing (agreement\|addendum))\\b", "type": "DPA"}, {"pattern": "\\b(SOW\|statement of work)\\b", "type": "SOW"}, {"pattern": "\\border form\\b", "type": "ORDER_FORM"}, {"pattern": "\\b(MSA\|master (services\|subscription) agreement)\\b", "type": "MSA"}]` | Case-insensitive patterns on the envelope subject, first match wins |
| `counterparty` |  | Where the counterparty name is read; otherwise the first external signer's email domain |
| `counterparty.customField` | `"counterparty"` |  |
| `counterparty.formField` | `"counterparty"` |  |
| `types` | `{"NDA": {"folder": "Legal/NDAs/{year}", "notify": null, "requireInternalSigner": false}, "MSA": {"folder": "Legal/Agreements/{counterparty}", "notify": "C0LEGAL0001", "requireInternalSigner": true}, "DPA": {"folder": "Legal/Agreements/{counterparty}/DPAs", "notify": "C0PRIVACY01", "requireInternalSigner": true}, "SOW": {"folder": "Legal/Agreements/{counterparty}/SOWs", "notify": null, "requireInternalSigner": true}, "ORDER_FORM": {"folder": "Sales/Order Forms/{year}/{counterparty}", "notify": "C0REVOPS001", "requireInternalSigner": false}}` | Agreement types this company files, and where |
| `review` |  | Unrecognized types and missing countersignatures go here, and this channel is told |
| `review.folder` | `"Legal/Needs filing review/{year}"` | Review folder; placeholders: {type} {counterparty} {year} {month} |
| `review.notify` | `"C0LEGAL0001"` |  |
| `fileName` | `"{date} {type} - {counterparty} ({envelopeId}).pdf"` | File name; placeholders: {date} {type} {counterparty} {envelopeId} {subject} |
| `includeCertificate` | `true` | Append DocuSign's certificate of completion to the filed PDF |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=signed-agreement-filing STATE_FILE=.state/signed-agreement-filing.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs signed-agreement-filing
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A Connect event starts one recorded run (provider-independent, so every later check is measured) | Executable declaration; result comes from a receipt |
| `docusign_unavailable_files_nothing` | When the envelope can't be read, nothing is filed and Legal is told the PDF is still only in DocuSign | Executable declaration; result comes from a receipt |
| `duplicate_delivery` | A re-delivered Connect event finds the same run and posts once | Executable declaration; result comes from a receipt |
| `concurrent_delivery` | Four simultaneous deliveries of the same event post once | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | An envelope id that isn't a DocuSign GUID is rejected before any agent runs | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limiting fails the Legal notice visibly; it is never reported as delivered | Executable declaration; result comes from a receipt |
| `restart_then_redelivery` | After a runtime restart, a re-delivered event finds the saved run and repeats nothing | Executable declaration; result comes from a receipt |
| `filed_in_type_folder` | A completed, countersigned MSA is filed with its certificate in the MSA folder of the policy's store and its channel is told | No DocuSign twin: the completed envelope, its form data and documents/combined can't be served, so nothing reaches the store. |
| `refiling_is_idempotent` | A second Connect delivery of a filed envelope (new run id) files nothing new | Needs the DocuSign twin (completed envelope) and a store that keeps uploaded files by name in their folder. |
| `type_from_subject` | With no type field, the subject rules classify the envelope (NDA → NDAs folder, nobody notified) | Needs the DocuSign twin to return an envelope subject and empty custom fields. |
| `unknown_type_to_review` | A type the policy doesn't know is filed to the review folder and Legal is told why; nothing is guessed | Needs the DocuSign twin to return a custom field the policy doesn't list. |
| `missing_countersignature_to_review` | A type that needs an internal countersignature, signed only externally, is filed for review | Needs the DocuSign twin to return recipients with per-signer status. |
| `not_completed_ignored` | A sent or delivered (not completed) envelope files nothing | Needs the DocuSign twin to return a non-completed envelope. |
| `dropbox_store` | With the policy's store set to Dropbox, the PDF is uploaded through content.dropboxapi.com without overwriting | No Dropbox twin. |
| `box_store_follows_box_api` | Filing into Box walks and creates the folder path (409 on an existing name) and uploads under the given name | The Box twin diverges from Box's API on every call the store makes, so even with DocuSign available the filing couldn't be judged. |
| `store_refusal_reported` | If the store refuses the upload, Legal is told the PDF is still only in DocuSign | Reaching the upload needs a completed DocuSign envelope; box:rate_limited/auth_failure can't be reached first. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-signed-agreement-filing-1.0.0-599e7fc`, verdict **inconclusive**, and statuses: **7 held**, **9 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/ce83edb34f?flow=vr_d4bd89d89ce84a58b8cc41798ede1685) · [Saved result](../../acme-ops/verify/receipts/signed-agreement-filing.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/signed-agreement-filing.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/signed-agreement-filing.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
