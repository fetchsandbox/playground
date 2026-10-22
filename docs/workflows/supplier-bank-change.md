# Supplier bank-detail change

## Business need

Accounts Payable needs to stop payment fraud through supplier bank-detail changes: nothing is paid to new details until a callback to the number on file and two different people have verified them.

Verify a supplier bank-detail change before any payment uses it: hold payments, call back the number on file, match account ownership, re-screen sanctions, then two-person approval; on rejection the old details stay. Hash-chained audit trail.

Demo organization: **Acme Corporation**. Department: **Finance**. Owning team: **accounts-payable**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "changeId": "BC-baseline",
    "vendorId": "731",
    "submittedBy": "U_AP_CLERK",
    "source": "email",
    "requestEmail": "billing@northwind.example",
    "newBank": {
      "accountName": "Northwind Traders LLC",
      "last4": "9012",
      "vaultToken": "tok_bank_9012",
      "plaidAccessToken": "access-sandbox-northwind"
    },
    "verifiers": [
      "U_AP_CLERK",
      "U_AP_VERIFIER"
    ],
    "apChannel": "C0FINANCE01",
    "securityChannel": "C0SECURITY1",
    "approvers": [
      "U_TREASURY",
      "U_AP_VERIFIER"
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
| `changeId` | yes | string |
| `vendorId` | yes | string |
| `submittedBy` | yes | string |
| `source` | yes | string / supplier_portal, email, phone |
| `requestEmail` | no/default | string |
| `newBank` | yes | object |
| `verifiers` | yes | array |
| `apChannel` | yes | string |
| `securityChannel` | yes | string |
| `apWorkspace` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `vendor-record` | netsuite |
| `bank-ownership` | plaid, netsuite |
| `sanctions` | screening, netsuite |
| `assessment` | No direct provider requirement; uses input or prior agent results |

**4 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `netsuite.hold_payments` | netsuite | **auto** | Hold payments to the supplier while the change is verified |
| `twilio.callback` | twilio_verify | **auto** | Call the phone number on file with a one-time code |
| `ap.confirm_callback` | netsuite | **auto** | Signal: an AP verifier (not the submitter) confirms the supplier read back the code |
| `treasury.approve` | netsuite | **auto** | Signal: a treasury approver who is neither the submitter nor the verifier approves |
| `netsuite.apply_bank_change` | netsuite | **auto** | Apply the vault-tokenised bank details, only after both signals |
| `netsuite.release_hold` | netsuite | **auto** | Release this change's payment hold (never another investigation's) |
| `gmail.notify_vendor` | gmail | **auto** | Draft a change notice to the supplier's email on file |
| `asana.change_record` | asana | **auto** | Change record with red flags |
| `slack.post_change` | slack | **auto** | AP or security alert, then the outcome |
| `slack.post_outcome` | slack | **auto** | Outcome once decided |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=supplier-bank-change STATE_FILE=.state/supplier-bank-change.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs supplier-bank-change
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A bank-change request is recorded for AP and posted | Executable declaration; result comes from a receipt |
| `payments_held_while_verifying` | Payments to the supplier are held as soon as the request arrives | Executable declaration; result comes from a receipt |
| `callback_to_number_on_file` | AP's callback goes to the phone number on file, never one from the request | Executable declaration; result comes from a receipt |
| `submitter_cannot_confirm` | The person who entered the change can't confirm its callback | Executable declaration; result comes from a receipt |
| `verifier_cannot_also_approve` | The AP verifier who confirmed the callback can't also give the treasury approval | Executable declaration; result comes from a receipt |
| `two_person_rule_applies_change` | Callback confirmed by AP and approved by treasury: the new bank details apply and the hold is released | Executable declaration; result comes from a receipt |
| `treasury_rejection_keeps_old_account` | A treasury rejection keeps the account on file and releases the hold | Executable declaration; result comes from a receipt |
| `callback_deadline_rejects` | Five days without a confirmed callback: the change is not applied (needs the verifier to advance the runtime's clock) | Executable declaration; result comes from a receipt |
| `ownership_checked_with_plaid` | The linked account's holder name is matched to the supplier's legal name | Executable declaration; result comes from a receipt |
| `sanctions_screened` | The supplier is re-screened against sanctions lists before anything changes | Executable declaration; result comes from a receipt |
| `unreadable_vendor_blocks` | When the vendor record can't be read nothing changes and AP is told | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limiting loses the alert only; the record is kept | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | Untokenised bank details are rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-supplier-bank-change-1.0.0-93f319c`, verdict **failing**, and statuses: **4 held**, **4 unmeasured**, **5 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/855eccad90?flow=vr_1d352154f9af49b5b8738b1d015ff7e8) · [Saved result](../../acme-ops/verify/receipts/supplier-bank-change.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/supplier-bank-change.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/supplier-bank-change.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
