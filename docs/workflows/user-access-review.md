# User access review

## Business need

IT Security needs quarterly access certifications that auditors accept: every entitlement decided by its owner, nobody certifying themselves, unreviewed admin access removed, and evidence that cannot be edited after the fact.

Quarterly SOC 2 access certification: pull every entitlement from WorkOS and GitHub, one keep/revoke decision per entitlement from its system owner (never self-review), reminders, deadline defaults (privileged revoked), verified revocations and a hash-chained evidence record.

Demo organization: **Acme Corporation**. Department: **IT Security**. Owning team: **grc**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "campaignId": "UAR-baseline",
    "scope": {
      "workosOrganizations": [
        "ORG_baseline"
      ]
    },
    "owners": {
      "workos": {
        "userId": "U_IT_OWNER",
        "email": "it.owner@acme.example"
      },
      "github": {
        "userId": "U_ENG_OWNER",
        "email": "eng.owner@acme.example"
      }
    },
    "githubEmails": {},
    "grcChannel": "C0SECURITY1",
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

| Field | Required | Type / allowed values |
|---|---|---|
| `campaignId` | yes | string |
| `scope` | yes | object |
| `owners` | yes | object |
| `githubEmails` | yes | object |
| `grcChannel` | yes | string |
| `grcWorkspace` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `workos-entitlements` | workos |
| `github-entitlements` | github |
| `campaign` | No direct provider requirement; uses input or prior agent results |

**3 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `access.decide_and_revoke` | workos | **auto** | Signal per entitlement from its owner (approve = revoke, reject = keep); deadline default: privileged revoked, standard kept |
| `slack.remind` | slack | **auto** | Day 7 and 12 reminders to reviewers with open decisions |
| `slack.campaign_opened` | slack | **auto** | Campaign scope posted to GRC |
| `asana.evidence_record` | asana | **auto** | Closing evidence record once every decision is settled |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=user-access-review STATE_FILE=.state/user-access-review.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs user-access-review
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A campaign reads the organization's memberships and opens: one decision per entitlement, posted to GRC | Executable declaration; result comes from a receipt |
| `campaign_covers_every_system` | With the GitHub organization in scope, its members are part of the campaign too | Executable declaration; result comes from a receipt |
| `owner_revokes_access` | The system owner's revoke decision removes the membership | Executable declaration; result comes from a receipt |
| `owner_keeps_access` | A keep decision leaves the membership in place | Executable declaration; result comes from a receipt |
| `no_self_review` | An owner can't certify their own admin access; the CISO decides it | Executable declaration; result comes from a receipt |
| `outsider_cannot_decide` | Someone who is neither the owner nor a GRC approver can't decide | Executable declaration; result comes from a receipt |
| `deadline_revokes_unreviewed_admin` | At the 14-day deadline unreviewed admin access is revoked (needs the verifier to advance the runtime's clock) | Executable declaration; result comes from a receipt |
| `reminder_only_for_open_items` | On day 7 the owner is reminded only if decisions are still open (needs clock control) | Executable declaration; result comes from a receipt |
| `github_member_revoked` | A revoke decision on a GitHub member removes them from the organization | Executable declaration; result comes from a receipt |
| `workos_unreadable_blocks` | When WorkOS can't be read, no campaign opens on partial data and GRC is told | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limiting loses the announcement only; the campaign still opens | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A malformed campaign id is rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-user-access-review-1.0.0-4ac41d8`, verdict **failing**, and statuses: **8 held**, **4 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/192682caf9?flow=vr_c14cb6f1efe04a0fbf095e93e9089086) · [Saved result](../../acme-ops/verify/receipts/user-access-review.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/user-access-review.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/user-access-review.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
