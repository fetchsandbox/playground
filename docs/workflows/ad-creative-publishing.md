# Owner-reviewed pergola ad publication

## Business need

Marketing needs the owner to review one exact pergola creative and paused ad before Meta creation, and must verify an uncertain outcome before retrying so a lost response does not create duplicate ads.

Research a seeded pergola creative, freeze an exact paused Meta ad, wait for owner approval and reconcile uncertain creation without blind resending. Sandbox demonstration; no live delivery or spend.

Demo organization: **Acme Corporation**. Department: **Marketing**. Owning team: **creative-operations**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "organization": "Acme",
    "customer": {
      "email": "builder@example.test"
    },
    "creativeId": "3001",
    "adsetId": "2001",
    "title": "Pergola consultation baseline {{run_id}}"
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
| `organization` | yes | string |
| `customer` | yes | object |
| `creativeId` | yes | string |
| `adsetId` | yes | string |
| `title` | yes | string |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `creative-research` | meta |
| `campaign-lead` | No direct provider requirement; uses input or prior agent results |

**2 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `meta.create_paused_ad` | meta | **approval** | Create one paused Meta ad only after review; uncertain outcomes are reconciled without resending |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| meta | `META_BASE_URL` (FetchSandbox Meta sandbox) + `META_API_KEY` (sandbox credential) | Bounded Graph26.0 PAUSED-ad demo only. No live Meta endpoint, delivery, review or billing is enabled. |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=ad-creative-publishing STATE_FILE=.state/ad-creative-publishing.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs ad-creative-publishing
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | Owner approval creates one paused ad and independently reads it back | Executable declaration; result comes from a receipt |
| `held` | Owner review holds the exact creative before any ad exists | Executable declaration; result comes from a receipt |
| `rejected` | A rejected review creates no ad | Executable declaration; result comes from a receipt |
| `wrong_reviewer` | An unconfigured reviewer cannot publish | Executable declaration; result comes from a receipt |
| `duplicate` | Replaying the approved decision does not create another ad | Executable declaration; result comes from a receipt |
| `restart_held` | A real worker restart preserves the held request and review boundary | Executable declaration; result comes from a receipt |
| `accepted_loss` | After acceptance and client timeout, resume reads the existing ad instead of resending | Executable declaration; result comes from a receipt |
| `wrong_business` | An input naming a different business cannot publish | Executable declaration; result comes from a receipt |
| `wrong_adset` | An ad set outside the configured policy cannot publish | Executable declaration; result comes from a receipt |
| `provider_auth` | A Meta authentication failure cannot produce an ad | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-ad-creative-publishing-1.0.0-4f90f60`, verdict **verified**, and statuses: **10 held**.

[Recorded receipt](https://fetchsandbox.com/runs/cbd22c286e?flow=vr_b190f863ba1a4adcaf2108b356654ade) · [Saved result](../../acme-ops/verify/receipts/ad-creative-publishing.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/ad-creative-publishing.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/ad-creative-publishing.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
