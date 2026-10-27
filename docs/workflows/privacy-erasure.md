# Privacy erasure request (GDPR / CCPA)

## Business need

Legal needs to honor data deletion requests across every system before the statutory deadline, while keeping records the law requires and never deleting for an unverified requester.

Find a data subject's records in HubSpot, Stripe and the WorkOS directory in parallel, decide per system (erase, anonymize, or retain under a legal hold such as an active subscription or unpaid invoice), record the request against its statutory deadline, and, after approval, delete the CRM contact, anonymize the billing customer and delete the login account, then draft the response to the requester. Unverified requests erase nothing.

Demo organization: **Acme Corporation**. Department: **Legal**. Owning team: **privacy-ops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "requestId": "DSR-baseline",
    "subject": {
      "email": "dsr-baseline@privacy.test",
      "name": "Erin Example"
    },
    "regulation": "gdpr",
    "receivedAt": "2026-10-15T09:00:00Z",
    "verification": {
      "method": "email_link",
      "verifiedBy": "privacy-portal"
    },
    "privacyChannel": "C0BILLING01",
    "approvers": [
      "U_DPO"
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
| `requestId` | yes | string |
| `subject` | yes | object |
| `regulation` | yes | string / gdpr, ccpa |
| `receivedAt` | yes | string |
| `verification` | yes | object |
| `privacyChannel` | yes | string |
| `dsarWorkspace` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `crm-records` | hubspot |
| `billing-records` | stripe |
| `identity-records` | workos |
| `erasure-plan` | No direct provider requirement; uses input or prior agent results |

**4 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `asana.dsar_record` | asana | **auto** | Request record with deadline and per-system decisions (no personal data) |
| `gmail.draft_verification_request` | gmail | **auto** | Draft asking an unverified requester to confirm |
| `hubspot.erase_contact` | hubspot | **approval** | Permanently delete the CRM contact (GDPR delete) |
| `stripe.anonymize_customer` | stripe | **approval** | Remove personal details from the billing customer; invoices stay for tax retention |
| `workos.delete_user` | workos | **approval** | Delete the login account |
| `gmail.draft_completion` | gmail | **approval** | Draft the response to the requester, only after the erasures went through |
| `slack.post_dsr` | slack | **auto** | Request status in the privacy channel (hashed subject) |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| hubspot | `HUBSPOT_API_KEY` (private-app token) | Custom contact properties must exist before the workflow writes them. |
| stripe | `STRIPE_API_KEY` (restricted key) | Pinned to Stripe API version `2024-12-18.acacia`; override with `STRIPE_API_VERSION` only after checking the field changes. |
| workos | `WORKOS_API_KEY` |  |
| asana | `ASANA_API_KEY` (personal access token) |  |
| gmail | `GMAIL_API_KEY` (OAuth access token) | Customer mail is created as drafts. |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=privacy-erasure STATE_FILE=.state/privacy-erasure.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs privacy-erasure
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A verified request finds the subject in all three systems, records it against the deadline, and parks every erasure for approval | Executable declaration; result comes from a receipt |
| `approve_erases` | Approval deletes the login account, anonymizes the billing customer and drafts the response; reconcile reads both back | Executable declaration; result comes from a receipt |
| `rejected` | A rejected request erases nothing | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | Someone who is not the DPO cannot approve erasure | Executable declaration; result comes from a receipt |
| `unverified_no_erasure` | An unverified request erases nothing and drafts a verification request | Executable declaration; result comes from a receipt |
| `active_subscription_retains_billing` | An active subscription holds the billing record; CRM and login are still erased on approval | Executable declaration; result comes from a receipt |
| `crm_only` | A subject found only in the CRM gets only the CRM erasure | Executable declaration; result comes from a receipt |
| `nothing_held` | A subject found nowhere gets the response drafted with no approval needed | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-delivered request records once | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four simultaneous deliveries of one request record once | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A request without a valid request id is rejected before any agent runs | Executable declaration; result comes from a receipt |
| `workos_auth_failure` | With the directory unreachable the request stays open: no response is drafted, found records still park for erasure | Executable declaration; result comes from a receipt |
| `hubspot_rate_limited` | With the CRM rate limited the request stays open and the other systems still park | Executable declaration; result comes from a receipt |
| `stripe_auth_failure` | With billing unreachable nothing billing-related is changed | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limiting fails the channel post only | Executable declaration; result comes from a receipt |
| `restart_while_parked` | Erasures parked for approval survive a real runtime restart and run once when approved | Executable declaration; result comes from a receipt |
| `crm_erasure_readback` | Reconcile independently confirms the HubSpot contact is gone after GDPR deletion | Executable declaration; result comes from a receipt |
| `privileged_account_flagged` | A real stored admin membership is detected and erasure waits for approval | Executable declaration; result comes from a receipt |
| `hold_rechecked_at_write` | A subscription created by an independent operator after discovery prevents billing erasure and the completion draft | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-privacy-erasure-1.0.0-639dac1`, verdict **verified**, and statuses: **19 held**.

[Recorded receipt](https://fetchsandbox.com/runs/93969092e3?flow=vr_1fae88cbe29d455aa062b167be9977ed) · [Saved result](../../acme-ops/verify/receipts/privacy-erasure.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/privacy-erasure.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/privacy-erasure.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
