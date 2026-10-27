# Account takeover containment

## Business need

IT Security needs to contain a suspected account takeover within minutes, holding money movement and removing admin access, without locking a customer organization out of its last admin or acting on an unreadable directory.

Score a suspected account takeover from the alert's signals and refund activity, then hold the account's Stripe refunds, revoke sessions and remove privileged WorkOS memberships, never the org's last admin without approval. Restore puts memberships back with approval.

Demo organization: **Acme Corporation**. Department: **IT**. Owning team: **it-security**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "stage": "contain",
    "alertId": "SEC-baseline",
    "email": "baseline@victim.example.com",
    "signals": [
      "mfa_reset",
      "admin_role_granted"
    ],
    "source": "idp-risk",
    "securityChannel": "C0SECURITY1",
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

### Input variant 1

| Field | Required | Type / allowed values |
|---|---|---|
| `stage` | yes | string / contain |
| `alertId` | yes | string |
| `email` | yes | string |
| `securityChannel` | yes | string |
| `securityWorkspace` | yes | string |
| `approvers` | no/default | array |
| `signals` | yes | array |
| `source` | yes | string |

### Input variant 2

| Field | Required | Type / allowed values |
|---|---|---|
| `stage` | yes | string / restore |
| `alertId` | yes | string |
| `email` | yes | string |
| `securityChannel` | yes | string |
| `securityWorkspace` | yes | string |
| `approvers` | no/default | array |
| `memberships` | yes | array |
| `releaseHold` | yes | boolean |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `identity` | workos |
| `billing` | stripe |
| `assessment` | No direct provider requirement; uses input or prior agent results |

**3 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `stripe.hold_customer` | stripe | **auto** | Mark the account's Stripe customers so refund workflows stop moving money |
| `workos.revoke_sessions` | workos | **auto** | Revoke the user's sessions (re-listed at write time) |
| `workos.remove_membership` | workos | **auto** | Remove a privileged membership; approval at medium risk, for an org's last admin, or past the per-alert limit |
| `workos.restore_membership` | workos | **approval** | Put back a membership from the containment record |
| `stripe.release_hold` | stripe | **approval** | Release this alert's refund hold |
| `asana.incident_record` | asana | **auto** | Incident record with the score, actions and restore input |
| `slack.post_alert` | slack | **auto** | Decision in the security channel |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| workos | `WORKOS_API_KEY` |  |
| stripe | `STRIPE_API_KEY` (restricted key) | Pinned to Stripe API version `2024-12-18.acacia`; override with `STRIPE_API_VERSION` only after checking the field changes. |
| asana | `ASANA_API_KEY` (personal access token) |  |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=account-takeover-containment STATE_FILE=.state/account-takeover-containment.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs account-takeover-containment
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A high-risk takeover holds the account's refunds and removes its admin seat in an organization that keeps another admin; the record and alert go out | Executable declaration; result comes from a receipt |
| `last_admin_parked` | The user's seat as an organization's only admin is not removed automatically: it waits for approval while the shared one goes | Executable declaration; result comes from a receipt |
| `last_admin_approved` | Security's approval removes the sole-admin seat once | Executable declaration; result comes from a receipt |
| `last_admin_rejected` | A rejected removal leaves the organization its admin | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | Someone who is not a security approver cannot release a removal | Executable declaration; result comes from a receipt |
| `medium_risk_asks_first` | At medium risk refunds are held at once but no membership is removed without approval | Executable declaration; result comes from a receipt |
| `low_risk_monitors` | A low-risk alert changes nothing and is posted for monitoring | Executable declaration; result comes from a receipt |
| `refund_spike_escalates` | A refund spike on the account's own Stripe customer raises a medium alert to high and contains it | Executable declaration; result comes from a receipt |
| `rerun_finds_contained` | A repeated alert (a new trigger) finds the account contained and changes nothing | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-delivered alert contains once | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four simultaneous deliveries of one alert contain once | Executable declaration; result comes from a receipt |
| `unknown_account_nothing` | An alert for an address with no user and no billing account changes nothing | Executable declaration; result comes from a receipt |
| `restore_with_approval` | After the investigation, restore waits for approval and then puts the removed admin seat back | Executable declaration; result comes from a receipt |
| `restore_leaves_other_hold` | Restore releases only its own alert's hold, never another investigation's | Executable declaration; result comes from a receipt |
| `workos_auth_failure` | Without the directory nothing is held or removed blindly; Slack escalates | Executable declaration; result comes from a receipt |
| `stripe_rate_limited` | When billing can't be read, containment still removes the admin seat but holds nothing | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limiting fails the post only; containment happens | Executable declaration; result comes from a receipt |
| `restart_while_parked` | A removal parked for approval survives a real runtime restart and is applied once when approved | Executable declaration; result comes from a receipt |
| `reconcile_reads_back` | Reconcile finds the membership still removed and the hold still on the customer | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | An alert with an unknown signal is rejected before any agent runs | Executable declaration; result comes from a receipt |
| `sessions_revoked` | Every live session of the user is revoked, including ones opened since the scan | The WorkOS twin's GET /user_management/users/{id}/sessions returns sample sessions under `items` (not the API's `data`), and POST /user_management/sessions/revoke echoes any id, so revocation can't be observed. The runtime lists and revokes real sessions; covered by local tests. |
| `co_admin_left_before_removal` | An automatic removal is refused when the organization's other admin left between the scan and the write | The verifier can't place a provider write between the runtime's directory read and its removal inside one run. The write-time re-check is covered by a deterministic local test. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-account-takeover-containment-1.0.0-40b5cbb`, verdict **inconclusive**, and statuses: **20 held**, **2 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/0af7cb3e63?flow=vr_2e81298bdd5645a38f14efcf2db1dcf0) · [Saved result](../../acme-ops/verify/receipts/account-takeover-containment.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/account-takeover-containment.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/account-takeover-containment.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
