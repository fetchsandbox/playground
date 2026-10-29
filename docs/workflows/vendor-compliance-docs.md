# Vendor compliance documents

## Business need

Procurement needs every supplier to sign the documents its risk calls for before it is activated, and needs to know before, not after, a supplier's insurance lapses, without tracking certificate dates in a spreadsheet.

Send a new supplier its onboarding packet by risk tier (W-9, terms or MSA, security addendum, DPA for personal data) through DocuSign and file it in Box or Dropbox on completion; track its certificate of insurance from the vendor's Insurance folder with notices before expiry, a drafted renewal request and a hold notice on expiry, standing down when a newer certificate is filed; tiers, templates, folders and notice days are policy.

Demo organization: **Acme Corporation**. Department: **Procurement**. Owning team: **supplier-onboarding**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "vendorId": "V-baseline",
    "vendor": {
      "legalName": "Initech baseline",
      "contactName": "Bill Lumbergh",
      "contactEmail": "bill@initech.example"
    },
    "riskTier": "high",
    "processesPersonalData": true
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
| `vendorId` | yes | string |
| `vendor` | yes | object |
| `riskTier` | yes | string / low, medium, high |
| `processesPersonalData` | yes | boolean |
| `insuranceOnly` | yes | boolean |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `envelopes` | docusign |
| `insurance` | No direct provider requirement; uses input or prior agent results |

**2 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `docusign.send_onboarding` | docusign | **auto** | Send the tier's onboarding packet (+ DPA for personal data) with DocuSign reminders and expiry; reuses an envelope already sent |
| `docusign.onboarding_completed` | box | **auto** | Signal: Connect reports completion (approve) or decline/void (reject); re-checked with DocuSign, then filed in Box or Dropbox |
| `procurement.unsigned` | slack | **auto** | Still unsigned 7 and 14 days after sending |
| `procurement.onboarding_declined` | slack | **auto** | Declined, voided, expired or not filed: don't activate the vendor |
| `procurement.coi_missing` | slack | **auto** | Tier requires insurance and the certificate is missing or expired |
| `procurement.coi_notice` | slack | **auto** | Certificate expires in 60, 30 and 7 days (stands down when renewed) |
| `gmail.coi_renewal_request` | gmail | **auto** | Renewal request to the vendor contact (draft) 30 days before expiry |
| `procurement.coi_expired` | slack | **auto** | Expired with no newer certificate: hold the vendor |
| `slack.post_no_packet` | slack | **auto** | No packet for the tier: nothing sent |
| `slack.post_blocked` | slack | **auto** | DocuSign unreadable: nothing sent |
| `slack.post_insurance_unreadable` | slack | **auto** | Insurance folder unreadable: expiry not tracked |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| docusign | `DOCUSIGN_BASE_URL` (your account's base URI) + `DOCUSIGN_API_KEY` (access token) + `DOCUSIGN_ACCOUNT_ID` |  |
| box | `BOX_API_KEY` (access token) | Uploads go to `upload.box.com`; override with `BOX_UPLOAD_URL` only for a test double. |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |
| gmail | `GMAIL_API_KEY` (OAuth access token) | Customer mail is created as drafts. |

**Set up in the provider accounts first:**

- DocuSign server templates for each packet (and the DPA), with a signer role named as the policy's `signerRole`; put their ids in the policy.
- A DocuSign Connect adapter that sends `signal` for `docusign.onboarding_completed` as the policy's `connectSender`.
- A vendor folder per supplier in Box or Dropbox (`Vendors/<legal name> (<vendor id>)` by default) with an `Insurance` sub-folder; file certificates as `COI <expiry date>.pdf`.
- A procurement-system hook that calls `start` when a supplier is approved, and again (with `insuranceOnly: true`) when a certificate is filed.

**Human decisions (signals).** These steps wait for a named person. Read the waiting action id from `status` (status `awaiting_signal`) and send:

```json
{ "action": "signal", "runId": "<run>", "actionId": "<waiting action id>", "value": "approve", "userId": "<approver id>", "note": "optional" }
```

Senders outside the allowed list, or excluded by segregation-of-duties rules, get HTTP 403.

- `docusign.onboarding_completed`: Connect reports completion (approve) or decline/void (reject); re-checked with DocuSign, then filed in Box or Dropbox

**Timers.** Reminders, deadlines and follow-ups are durable timers. A deployed stack sends `{"action":"tick"}` on the schedule `rate(1 hour)` (EventBridge Scheduler); locally, set `TICK_INTERVAL_MS` or send `tick` yourself.

**Audit trail.** Every decision, signal and effect is hash-chained. `{"action":"evidence","runId":"<run>"}` returns the trail and whether the chain verifies.

## Configurable policy

Every limit, deadline, routing rule and folder layout lives in [`acme-ops/policies/vendor-compliance-docs.json`](../../acme-ops/policies/vendor-compliance-docs.json), not in the code. The workflow validates it at startup against its schema and refuses to start on an invalid value. Each run records the policy version it started under and keeps it until it finishes.

Override per deployment without a code change: `POLICY_FILE=/path/override.json` (a mounted file) and/or `POLICY_JSON='{...}'` (an environment value or secret). Objects merge key by key; lists and values replace. On AWS: `cdk deploy -c policyFile:<workflow>=override.json`. `{"action":"describe"}` returns the effective values, their version and the JSON Schema.

| Setting | Default | Meaning |
|---|---|---|
| `store` |  | Where documents are filed |
| `store.provider` | `"box"` | Document store: box or dropbox |
| `store.root` | `"0"` | Box: the root folder id ("0" is All Files). Dropbox: a path such as "/Acme" ("" is the account or team root) |
| `vendorFolder` | `"Vendors/{vendor} ({vendorId})"` | Vendor folder below the store root; placeholders: {vendor} {vendorId} |
| `packets` | `[{"name": "High-risk vendor", "match": {"riskTier": ["high"]}, "templates": ["w9-template-id", "vendor-msa-template-id", "security-addendum-template-id"]}, {"name": "Standard vendor", "match": {"riskTier": ["medium", "low"]}, "templates": ["w9-template-id", "vendor-terms-template-id"]}]` | Onboarding packets by risk tier; first match wins |
| `dpaTemplate` | `"dpa-template-id"` | Appended when the vendor will process personal data (null: never) |
| `signerRole` | `"Vendor"` | Template role the vendor contact fills |
| `countersigner` | `{"roleName": "Procurement", "name": "Acme Procurement", "email": "procurement@acme.example"}` | Signs after the vendor (null: nobody) |
| `subject` | `"{vendor}: Acme supplier onboarding documents"` | Envelope subject; placeholders: {vendor} |
| `docusign` |  | DocuSign's own reminders and expiry |
| `docusign.reminderDelayDays` | `3` |  |
| `docusign.reminderEveryDays` | `3` |  |
| `docusign.expireDays` | `30` |  |
| `connectSender` | `"docusign-connect"` | User id your DocuSign Connect adapter signals completion as |
| `unsignedEscalateDays` | `[7, 14]` | Tell Procurement this many days after sending if still unsigned |
| `onboardingFolder` | `"Onboarding"` | Sub-folder of the vendor folder for signed onboarding documents |
| `fileName` | `"{date} Onboarding documents - {vendor}.pdf"` | Signed packet file name; placeholders: {date} {vendor} {vendorId} |
| `insurance` |  | Certificate of insurance tracking |
| `insurance.requiredTiers` | `["medium", "high"]` | Tiers that must hold a current certificate of insurance |
| `insurance.folder` | `"Insurance"` | Sub-folder of the vendor folder holding certificates |
| `insurance.certificatePattern` | `"^COI (\\d{4}-\\d{2}-\\d{2})\\b"` | File-name pattern of a certificate; group 1 is its expiry date |
| `insurance.noticeDays` | `[60, 30, 7]` | Tell Procurement this many days before expiry |
| `insurance.renewalSubject` | `"Updated certificate of insurance for Acme"` |  |
| `insurance.requestRenewalAtDays` | `30` | Draft the renewal request to the vendor this many days before expiry |
| `procurementChannel` | `"C0PROCURE01"` | Slack channel for Procurement |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=vendor-compliance-docs STATE_FILE=.state/vendor-compliance-docs.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs vendor-compliance-docs
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | An onboarding request starts one recorded run (provider-independent, so every later check is measured) | Executable declaration; result comes from a receipt |
| `docusign_unavailable_sends_nothing` | When DocuSign can't be checked, no onboarding documents are sent and Procurement is told | Executable declaration; result comes from a receipt |
| `insurance_folder_read_from_box` | The vendor's Insurance folder is read from Box (folder walk from the root, marker paging) | Executable declaration; result comes from a receipt |
| `missing_certificate_raised` | A high-risk vendor with no certificate in its Insurance folder is raised to Procurement at once | Executable declaration; result comes from a receipt |
| `unreadable_folder_is_not_missing` | If Box refuses the folder read, Procurement is told expiry isn't tracked; it is never reported as 'no certificate' | Executable declaration; result comes from a receipt |
| `duplicate_request` | A re-delivered onboarding request finds the same run and posts once | Executable declaration; result comes from a receipt |
| `concurrent_requests` | Four simultaneous deliveries post once | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | An unknown risk tier or invalid contact email is rejected before any agent runs | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limiting fails the Procurement notice visibly | Executable declaration; result comes from a receipt |
| `restart_then_redelivery` | After a runtime restart, a re-delivered request finds the saved run and repeats nothing | Executable declaration; result comes from a receipt |
| `packet_by_tier_with_dpa` | A high-risk vendor processing personal data gets W-9, MSA, security addendum and DPA in one envelope, countersigned by Procurement | No DocuSign twin. |
| `onboarding_filed_on_completion` | Connect completion is re-checked with DocuSign and the signed packet is filed in the vendor's Onboarding folder | No DocuSign twin; Box twin uploads lose name and parent. |
| `envelope_reused` | Re-onboarding the same vendor reuses its envelope | Needs DocuSign envelope listing by custom_field. |
| `unsigned_and_declined_escalated` | Unsigned after 7 and 14 days, and declined, are each escalated | Needs the DocuSign twin and the runtime clock to advance during an attempt. |
| `certificate_notices_and_renewal_draft` | 60/30/7-day notices, a renewal request drafted to the vendor at 30 days, and a hold notice on expiry | A dated certificate can't be seeded into a Box folder (name and parent dropped), and the timers need the runtime clock during an attempt. |
| `renewed_certificate_stands_down` | A newer certificate filed in the folder stands every remaining insurance timer down | Needs a stateful Box folder (R29) and the clock. |
| `dropbox_store` | With the store set to Dropbox, the Insurance folder is listed and the packet uploaded there | No Dropbox twin. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-vendor-compliance-docs-1.0.0-47e9bd7`, verdict **failing**, and statuses: **8 held**, **7 unmeasured**, **2 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/300dcbf02e?flow=vr_d0c78fb1728b453eadb202ee705eae11) · [Saved result](../../acme-ops/verify/receipts/vendor-compliance-docs.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/vendor-compliance-docs.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/vendor-compliance-docs.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
