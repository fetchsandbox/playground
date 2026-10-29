# External sharing audit

## Business need

Security needs to know that no payroll file, customer export or passport scan sits behind a public link with no expiry, in either document store, and needs it fixed without breaking links people rely on or overriding a fix someone already made.

Inventory every shared link in Box and Dropbox and enforce the sharing policy: restrict public links to sensitive items, give public links a maximum expiry, skip exempt folders; each change re-reads the link first, revocations and changes past the per-run limit need a security approver, and a store that can't be read is reported as not audited; patterns, limits and remedies are policy.

Demo organization: **Acme Corporation**. Department: **Security**. Owning team: **data-protection**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "auditId": "SHARE-baseline",
    "approvers": [
      "U_SECLEAD"
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
| `auditId` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `box-links` | box |
| `dropbox-links` | dropbox |

**2 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `sharing.restrict` | box | **auto** | Public link to a sensitive item: restricted to the company (Box) or team (Dropbox) |
| `sharing.set_expiry` | box | **auto** | Public link without, or past, the maximum expiry: set to the policy's maximum |
| `sharing.revoke` | box | **approval** | Remove the link entirely (approval by default) |
| `slack.post_audit` | slack | **auto** | Audit summary: findings, what was fixed, what waits, and which sources weren't audited |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| box | `BOX_API_KEY` (access token) | Uploads go to `upload.box.com`; override with `BOX_UPLOAD_URL` only for a test double. |
| dropbox | `DROPBOX_API_KEY` (OAuth access token; + `DROPBOX_PATH_ROOT` for a team space) | RPC calls go to `api.dropboxapi.com`, uploads and downloads to `content.dropboxapi.com`. |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |

**Set up in the provider accounts first:**

- A Box token that can see the policy's root folders, and a Dropbox token for the account to audit (team-wide Dropbox audits need a team admin token per member, not included).
- A weekly schedule (or an on-demand trigger) that calls `start` with an audit id such as `SHARE-2026-W44`; security approvers in the input or `APPROVER_USER_IDS`.
- Your sensitive-name patterns, exempt folders and maximum public-link age in the policy.

**Audit trail.** Every decision, signal and effect is hash-chained. `{"action":"evidence","runId":"<run>"}` returns the trail and whether the chain verifies.

## Configurable policy

Every limit, deadline, routing rule and folder layout lives in [`acme-ops/policies/external-sharing-audit.json`](../../acme-ops/policies/external-sharing-audit.json), not in the code. The workflow validates it at startup against its schema and refuses to start on an invalid value. Each run records the policy version it started under and keeps it until it finishes.

Override per deployment without a code change: `POLICY_FILE=/path/override.json` (a mounted file) and/or `POLICY_JSON='{...}'` (an environment value or secret). Objects merge key by key; lists and values replace. On AWS: `cdk deploy -c policyFile:<workflow>=override.json`. `{"action":"describe"}` returns the effective values, their version and the JSON Schema.

| Setting | Default | Meaning |
|---|---|---|
| `sources` |  | Which stores to audit |
| `sources.box.enabled` | `true` |  |
| `sources.box.rootFolders` | `["0"]` | Folders to sweep ("0" is everything the token can see) |
| `sources.box.maxItems` | `5000` | Stop after this many items; the run then says the sweep was partial |
| `sources.dropbox.enabled` | `true` |  |
| `exemptPaths` | `["Marketing/Public", "Press Kit"]` | Path prefixes (below the root, case-insensitive) whose links are allowed to be public |
| `publicMaxDays` | `30` | Longest a public link may stay up |
| `passwordCountsAsRestricted` | `true` | Treat a password-protected public link as restricted |
| `sensitivePatterns` | `["payroll", "salar(y\|ies)", "\\bssn\\b", "passport", "\\bw-?2\\b", "customer[ _-]?(export\|list)", "bank[ _-]?details", "\\.(csv\|xlsx)$"]` | Case-insensitive patterns on the item path; a match makes a public link sensitive |
| `remediation` |  | What to do about each finding |
| `remediation.sensitivePublic` | `"restrict"` | Public link to a sensitive item |
| `remediation.publicNoExpiry` | `"set_expiry"` | Public link without an expiry |
| `remediation.publicExpiryTooLong` | `"set_expiry"` | Public link expiring later than publicMaxDays |
| `remediation.approvalFor` | `["revoke"]` | Remedies that always wait for a security approver |
| `remediation.autoLimit` | `25` | Automatic changes per run; the rest wait for approval |
| `securityChannel` | `"C0SECURITY1"` | Slack channel for the audit summary |
| `reportTop` | `10` | Findings listed in the summary |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=external-sharing-audit STATE_FILE=.state/external-sharing-audit.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs external-sharing-audit
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A scheduled audit starts one recorded run (provider-independent, so every later check is measured) | Executable declaration; result comes from a receipt |
| `box_links_inventoried` | Every shared link in the Box tree is inventoried (folder walk with fields=shared_link, marker paging) | Executable declaration; result comes from a receipt |
| `unreadable_store_not_clean` | Dropbox, which can't be read here, is reported as not audited and nothing is changed | Executable declaration; result comes from a receipt |
| `box_auth_failure_not_clean` | If Box refuses the token, Box is reported as not audited and nothing is changed | Executable declaration; result comes from a receipt |
| `duplicate_audit` | A re-delivered audit trigger finds the same run and posts one summary | Executable declaration; result comes from a receipt |
| `concurrent_audits` | Four simultaneous triggers post one summary | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | An audit id outside the SHARE- format is rejected before any agent runs | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limiting fails the summary visibly | Executable declaration; result comes from a receipt |
| `restart_then_redelivery` | After a runtime restart, a re-delivered trigger finds the saved run and repeats nothing | Executable declaration; result comes from a receipt |
| `sensitive_public_restricted` | A public link to a sensitive item (payroll, customer export) is restricted to the company | A public Box link can't be staged on a session item, and the Box tree can't be read. |
| `expiry_capped` | A public link with no expiry, or past the maximum, gets the policy's maximum expiry | Same Box twin divergences. |
| `exempt_and_restricted_left_alone` | Exempt folders, company-only and password links are left alone | Same Box twin divergences. |
| `change_since_sweep_respected` | A link fixed or replaced after the sweep is not changed again | Needs a link whose state the contract can change between planning and approval (external-operator input on Box) and a readable Box tree. |
| `revoke_needs_approval` | Revocation and changes past the per-run limit wait for a security approver | Needs findings, which need a readable Box tree with staged public links. |
| `dropbox_links_enforced` | Dropbox shared links are listed (cursor paging) and narrowed with modify_shared_link_settings | No Dropbox twin. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-external-sharing-audit-1.0.0-53a03cd`, verdict **failing**, and statuses: **8 held**, **6 unmeasured**, **1 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/2911898104?flow=vr_a5c6c476217148e89c3501f4618a5e2f) · [Saved result](../../acme-ops/verify/receipts/external-sharing-audit.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/external-sharing-audit.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/external-sharing-audit.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
