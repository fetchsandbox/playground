# SaaS license reclaim

## Business need

IT Asset Management needs to recover unused seats after a warning and grace period, with approval before removing access.

Scan the directory for seats idle past the policy, warn their owners, and reclaim seats still idle after the grace period once IT approves; reconcile proves each reclaimed account is gone.

Demo organization: **Acme Corporation**. Department: **IT**. Owning team: **it-asset-mgmt**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "itChannel": "C0GENERAL01",
    "approvers": [
      "U_IT_ASSETS"
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
| `organizationId` | no/default | string |
| `inactiveDays` | yes | integer |
| `graceDays` | yes | integer |
| `itChannel` | yes | string |
| `excludeEmails` | yes | array |
| `maxReclaims` | yes | integer |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `directory-scan` | workos |

**1 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `slack.post_summary` | slack | **auto** | Post the idle-seat summary to IT |
| `gmail.draft_warning` | gmail | **auto** | Draft (not send) a sign-in-or-lose-it warning per idle user |
| `workos.reclaim_seat` | workos | **approval** | Delete the directory account of a seat idle past the grace period |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| workos | `WORKOS_API_KEY` |  |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |
| gmail | `GMAIL_API_KEY` (OAuth access token) | Customer mail is created as drafts. |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=license-reclaim STATE_FILE=.state/license-reclaim.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs license-reclaim
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | Monthly scan posts the idle-seat summary and proposes reclaiming every seat idle past the grace period | Executable declaration; result comes from a receipt |
| `exclusions_respected` | Excluded accounts are never warned or reclaimed | Executable declaration; result comes from a receipt |
| `within_policy_is_quiet` | Seats idle less than the policy produce no action | Executable declaration; result comes from a receipt |
| `warning_window` | Seats idle past the policy but inside the grace period get warning drafts, not reclaims | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | A non-approver cannot reclaim seats | Executable declaration; result comes from a receipt |
| `reject` | Rejecting leaves every seat in place | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-fired schedule does not post twice | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four more simultaneous firings create one run | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A 3-day inactivity policy is rejected as too aggressive | Executable declaration; result comes from a receipt |
| `workos_auth_failure` | If the directory can't be read nothing is proposed | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | A Slack failure loses the summary only; reclaims still await approval | Executable declaration; result comes from a receipt |
| `gmail_rate_limited` | A Gmail failure fails the warning drafts and is reported, not hidden | Executable declaration; result comes from a receipt |
| `restart_while_parked` | A parked reclaim survives a runtime restart; the decision taken afterwards is honored | Executable declaration; result comes from a receipt |
| `approve_and_reconcile` | Approved reclaims delete the idle accounts and reconcile proves each one is gone | Executable declaration; result comes from a receipt |
| `license_cost_savings` | Each reclaimed seat is priced from the vendor contract to report savings | No license-cost or contract system is connected (and no twin exists); the run reports seat counts only. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-license-reclaim-1.0.0-df79afd`, verdict **inconclusive**, and statuses: **14 held**, **1 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/d9d39ca07c?flow=vr_b6cd213a86a14632978339bb9525293e) · [Saved result](../../acme-ops/verify/receipts/license-reclaim.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/license-reclaim.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/license-reclaim.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
