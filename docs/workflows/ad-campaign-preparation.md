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

The checked-in receipt records app version `acme-ops-ad-campaign-preparation-1.0.0-02fca24`, verdict **verified**, and statuses: **16 held**.

[Recorded receipt](https://fetchsandbox.com/runs/28e3ab6313?flow=vr_64fb6753c0fe4d6293782ed88eb3d83c) · [Saved result](../../acme-ops/verify/receipts/ad-campaign-preparation.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/ad-campaign-preparation.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/ad-campaign-preparation.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)


## Bounded deployment and deliberate failure proof

The two roles use deterministic checks; this workflow does not ask an LLM to draft or approve ads. The deployed AgentCore version 1 uses source `c9fdee7`; later contract-only revisions preserve bundle SHA256 `04cf0554edbb45740b89219663b491b3352b5b364f8476fbfecb68f13a2cd4fa`. Native Facebook and Instagram runs each checked durable waiting state, reviewer refusal, four linked objects, reconciliation and replay. The reviewer was scripted under AWS IAM, not a human UI. [Native observations](../evidence/ad-preparation-native-20261030.json).

The passing and deliberately changed blind-resend variant used identical checks. Each of four lost-response cases left one object in the original and two distinct objects in the faulty variant; the verifier rejected the repeated writes. The negative unavailable-read-back case remained unmeasured. [Same-contract comparison and separate receipts](../evidence/ad-preparation-comparison-20261030.json).

Live Meta qualification remains pending account login. Media upload, activation, native ad review, delivery, spend and device-bound human approval are not included. Snapchat has a separate bounded provider foundation; this application does not claim a Snapchat advertising workflow.

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
