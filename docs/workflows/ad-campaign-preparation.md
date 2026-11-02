# Owner-reviewed Facebook and Instagram feed campaign preparation

## Business need

Marketing needs one owner-reviewed budget, destination and creative to produce a linked Facebook or Instagram campaign, ad set, creative and ad that remain paused. If a provider response is lost, the workflow must recover the saved intent by observation without duplicating the effect.

Review business, budget, destination and creative before preparing linked paused campaign/adset/creative/ad objects. Existing image fixture only; no live delivery.

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
    "platform": "instagram",
    "title": "Pergola baseline {{run_id}}",
    "message": "Plan your pergola consultation",
    "link": "https://example.test/pergolas",
    "dailyBudgetMinor": 1000
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
| `platform` | yes | string / facebook, instagram |
| `title` | yes | string |
| `message` | yes | string |
| `link` | yes | string |
| `dailyBudgetMinor` | yes | integer |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `policy-review` | No direct provider requirement; uses input or prior agent results |
| `campaign-planner` | meta |

**2 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `meta.prepare_campaigns` | meta | **approval** | Owner-reviewed paused preparation; uncertain writes require read-back, never blind resend |
| `meta.prepare_adsets` | meta | **approval** | Owner-reviewed paused preparation; uncertain writes require read-back, never blind resend |
| `meta.prepare_adcreatives` | meta | **approval** | Owner-reviewed paused preparation; uncertain writes require read-back, never blind resend |
| `meta.prepare_ads` | meta | **approval** | Owner-reviewed paused preparation; uncertain writes require read-back, never blind resend |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| meta | `META_BASE_URL` (FetchSandbox Meta sandbox) + `META_API_KEY` (sandbox credential) | Bounded Graph26.0 paused preparation only; supported objects depend on the workflow. No live Meta endpoint, delivery, native review or billing is enabled. |

**Set up in the provider accounts first:**

- A FetchSandbox Meta fixture containing the configured account, Page, Instagram identity and pre-existing image hash. These fictional identities are not native permission evidence.
- Set `AD_PREPARATION_POLICY_JSON` to the owner policy (version, organization, account, pageId, instagramUserId, imageHash, maxDailyBudgetMinor, destinationHosts). The example default is Acme, act_1001, Page 4001, Instagram 5001 and demo-image-1001.
- Configure named `APPROVER_USER_IDS`. This workflow uses the native approval gate; it does not enable the LoopLabs signed review bridge. Each write has a separate durable intent; uncertain effects require exact read-back, never blind resend.
- Only paused campaigns, ad sets, link creatives and ads are prepared. No image upload, activation, delivery, native review or spend is included.

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=ad-campaign-preparation STATE_FILE=.state/ad-campaign-preparation.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs ad-campaign-preparation
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | Instagram preparation creates one linked paused hierarchy after approval | Executable declaration; result comes from a receipt |
| `held` | No preparation writes before owner approval | Executable declaration; result comes from a receipt |
| `facebook` | Facebook feed uses the same approval and preparation boundaries | Executable declaration; result comes from a receipt |
| `rejected` | Rejected preparation creates no objects | Executable declaration; result comes from a receipt |
| `wrong_reviewer` | An unconfigured reviewer cannot release preparation | Executable declaration; result comes from a receipt |
| `replay` | Approval replay does not repeat any of the four writes | Executable declaration; result comes from a receipt |
| `budget` | Above-policy daily budget creates nothing | Executable declaration; result comes from a receipt |
| `business` | Wrong organization creates nothing | Executable declaration; result comes from a receipt |
| `destination` | Unapproved destination creates nothing | Executable declaration; result comes from a receipt |
| `provider_auth` | Provider authentication refusal cannot create objects | Executable declaration; result comes from a receipt |
| `unknown` | Unavailable read-back leaves the accepted ad unresolved and never resends | Executable declaration; result comes from a receipt |
| `restart` | A real worker restart preserves the review and subsequent effects | Executable declaration; result comes from a receipt |
| `campaign_loss` | Accepted campaigns response loss recovers without resending | Executable declaration; result comes from a receipt |
| `adset_loss` | Accepted adsets response loss recovers without resending | Executable declaration; result comes from a receipt |
| `creative_loss` | Accepted adcreatives response loss recovers without resending | Executable declaration; result comes from a receipt |
| `ad_loss` | Accepted ads response loss recovers without resending | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-ad-campaign-preparation-1.0.0-3d96f14`, verdict **verified**, and statuses: **16 held**.

[Recorded receipt](https://fetchsandbox.com/runs/baa581e5b0?flow=vr_40cddd2b2da44a96b27b4a878acedb38) · [Saved result](../../acme-ops/verify/receipts/ad-campaign-preparation.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/ad-campaign-preparation.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/ad-campaign-preparation.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)


## Bounded deployment and deliberate failure proof

Initial November 1 deployment: FetchSandbox backend `8ba275bf`; AgentCore version 2, runtime source `ab5ea6d23b3b433c91d8f242f7e1b989fb30e8a6`. That deployment used hosted contract `ab08b3f`; its runtime bundle is byte-identical to the AWS image (SHA256 `3ec8c3c1437adeaaa808994b02364f5ce0dbd615b72d8875fe18ef2b892afa56`). Ownership is Acme Corporation / Marketing / creative-operations / Raj. Roles use deterministic checks, and the measured approver is scripted under AWS IAM, not a device-bound human UI.

The fresh hosted preparation run passed all 16 declared checks, including actual app-process restart and four accepted-response-loss cases. Independent provider reads confirmed exactly one campaign, ad set, creative and ad for each writing case, with linked IDs, paused statuses and disabled audience expansion. Restoring only the old strict-name defect under the same final check contract violated baseline; the other 15 checks were unmeasured because baseline failed. Independent negative-state counts were 1 campaign, 1 ad set, 1 creative and 0 ads. [Current deployment, separate receipts and measured limits](../evidence/ad-preparation-release-20261101.json).

The separate ad-only regression passed its 10 checks. Actual AgentCore invocations for Facebook and Instagram against FetchSandbox each measured waiting without effects, wrong-reviewer refusal, authorized approval, four reconciliation matches, repeat approval without duplicate objects, and consistent DynamoDB read-back. This is AWS/application acceptance against FetchSandbox; it does not establish native Meta or Instagram end-to-end acceptance.

Native-observed budget-sharing, bid-strategy, audience and creative-name behavior are now deployed in the bounded Meta handler. The app binds names to a run/account/policy reference shown in review, accepts the measured date/hash suffix on first read, then freezes the full returned name. Acknowledged IDs are saved before read-back. Unknown responses require one matching account/story/run-bound candidate and an independent read; conflicts and ambiguity stop dependent writes rather than resend. [Earlier local and native action-level naming evidence](../evidence/ad-preparation-naming-20261101.json). Native identical creative requests reused one ID, but this does not establish universal or concurrent idempotency.

The [October 30 AWS observations](../evidence/ad-preparation-native-20261030.json) and [historical deliberate duplicate-effect comparison](../evidence/ad-preparation-comparison-20261030.json) describe older versions. Their creative duplicate result does not establish current or native behavior. Earlier setup and contract-assertion failures are retained in the current release evidence, not counted as passes.

Native Instagram qualification, application media upload, activation/review/delivery/spend, device-bound approval and a LoopLabs browser controls comparison remain unmeasured. No live Meta fallback or continuous native drift monitor is introduced. Historical saved runs are not migrated or requalified by these fresh checks.


### Signed preparation review adapter

The follow-up source `2d62db5` extends the existing signed LoopLabs bridge to this four-action preparation workflow. The review binds business input, policy version/hash, budget, audience, destination, creative reference and all four paused action summaries. When this adapter is configured, direct native approval is refused. Typed policy events identify `ad-preparation-policy` and omit email, destination and creative message. [Follow-up deployment and separate proof scopes](../evidence/ad-preparation-control-20261101.json).

The actual local HTTP app process passed six control cases against FetchSandbox, with independent provider and file-state read-back. Approved work created one linked paused hierarchy; rejection, stale revision, wrong reviewer, changed input and changed policy produced no objects. A changed policy can accept the approval request but still records a partial execution outcome; HTTP 200 is not workflow success. Replay made no duplicate objects, and approval survived process restart. These are scripted bridge checks, not a human browser or device-bound approval.

The follow-up hosted run uses the unchanged 16-case contract with control disabled to check native approval and recovery compatibility. Its earlier attempt passed 10 cases before the relay disconnected and left six unmeasured; the same-build retry passed all 16. Both receipts are retained separately. Native Instagram still requires its own professional identity; the dedicated Facebook Page currently has no linked Instagram profile. No live Meta fallback or ad activation is enabled.


AgentCore version 4 deploys this signed-review capability; pinned version 2 retains its separate native approval path and original secret. The AWS comparison observed four linked paused objects, four reconciliation matches, consistent DynamoDB state and replay counts 1/1/1/1 in both paths. Version 4 also refused invalid signatures, wrong scope, direct approval bypass and stale review. Version 3 startup failure and the exact environment-only correction are preserved in the evidence.

History enrollment is saved in LoopLabs under the existing invited owner. The unchanged version-filtered forwarder measured 16/16 events for a fresh held-then-rejected zero-effect run; the prior 17 successful-run events were separately backfilled. The measured UI read has 33 version-4 events across two executions with no unsupported-format warning for that range. This is source-reported observation, not provider certification. Actual LoopLabs shared approval still requires the existing tenant, connection, saved enrollment epoch and real invited reviewer binding. Company relabeling does not establish that authority.


## November 1 requester guard and v5 follow-up

Runtime source `3d96f14` is deployed as AgentCore version 5. The decision compare-and-swap refuses a requester reviewing their own request even when the customer email differs; the two new regression cases failed before this change. All 399 app tests passed. The unchanged hosted 16-case contract passed with independent provider state checks and disposable-key/relay cleanup. [Separate v5 evidence and limits](../evidence/ad-preparation-identity-20261101.json).

LoopLabs PR #159 is merged and deployed as `f6e77f9`, with its running image and exact v5 approval binding independently verified. The identical-tree CI candidate passed all three jobs, including 3,555 quality tests across 384 files. The named-account API test refused self-review and a non-reviewer (403), stale review (409), and replay (409). A separate valid approval produced exactly one linked campaign, ad set, creative and ad; delivery objects remained paused, durable state matched provider IDs and all four reconciliation checks matched. Fresh history matched 37 distinct events, with 10 duplicate deliveries counted separately. This uses FetchSandbox provider fixtures, not native Meta. V4 and its original secret/enrollment remain preserved. The original browser example remains awaiting review: Chrome is signed out, so actual browser acceptance is untested. Authenticated initiating-human attestation, native Instagram and full native Meta workflow acceptance remain unmeasured. The temporary deployment SSH rule was removed and original firewall rules restored.

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
