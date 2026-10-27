# Partner sanctions re-screen

## Business need

Compliance must catch partners who become sanctioned after onboarding, stop their payouts before money moves, avoid re-reviewing the same false positives, and meet the SAR filing deadline.

Re-screen every connected account in a program against the sanctions lists; hold payouts at once on strong matches, have an analyst decide each match, record false positives so they aren't re-raised, release precautionary holds, and route true matches to the MLRO for the SAR decision within 30 days of detection.

Demo organization: **Acme Corporation**. Department: **Compliance**. Owning team: **financial-crimes**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "rescreenId": "KYC-baseline",
    "program": "kyc-baseline",
    "complianceChannel": "C0COMPLY001",
    "analysts": [
      "U_ANALYST"
    ],
    "mlro": [
      "U_MLRO",
      "U_ANALYST"
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
| `rescreenId` | yes | string |
| `program` | yes | string |
| `complianceChannel` | yes | string |
| `analysts` | yes | array |
| `mlro` | yes | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `screening` | stripe, screening |

**1 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `stripe.precautionary_hold` | stripe | **auto** | Strong match: payouts to manual at once |
| `compliance.review` | stripe | **auto** | Signal: analyst decides true match (hold) or false positive |
| `stripe.clear` | stripe | **auto** | False positive: record clearance for this hit set, release a precautionary hold |
| `mlro.sar_decision` | slack | **auto** | Signal: MLRO (not the analyst) decides on a SAR within 30 days of detection |
| `compliance.remind` | slack | **auto** | Reminder every 3 days while undecided |
| `slack.post_rescreen` | slack | **auto** | Sweep summary |

## Providers, credentials and operations

Put these in the runtime's private `.env` locally, or in the stack's Secrets Manager secret when deployed (see [`acme-ops/.env.example`](../../acme-ops/.env.example)). A provider without credentials is reported as *not configured*; its agents and actions are skipped, never faked.

| Provider | Environment | Notes |
|---|---|---|
| stripe | `STRIPE_API_KEY` (restricted key) | Pinned to Stripe API version `2024-12-18.acacia`; override with `STRIPE_API_VERSION` only after checking the field changes. |
| screening | `TRADE_GOV_API_KEY` (developer.trade.gov subscription key) | Sent as the `subscription-key` header. |
| slack | `SLACK_API_KEY` (bot token, `chat:write`) | Invite the bot to every channel the input names. |

**Set up in the provider accounts first:**

- Stripe Connect accounts in scope carry `metadata.acme_program`. The platform must be allowed to set their payout schedule (platform controls or loss liability).

**Human decisions (signals).** These steps wait for a named person. Read the waiting action id from `status` (status `awaiting_signal`) and send:

```json
{ "action": "signal", "runId": "<run>", "actionId": "<waiting action id>", "value": "approve", "userId": "<approver id>", "note": "optional" }
```

Senders outside the allowed list, or excluded by segregation-of-duties rules, get HTTP 403.

- `compliance.review`: analyst decides true match (hold) or false positive
- `mlro.sar_decision`: MLRO (not the analyst) decides on a SAR within 30 days of detection

**Timers.** Reminders, deadlines and follow-ups are durable timers. A deployed stack sends `{"action":"tick"}` on the schedule `rate(1 hour)` (EventBridge Scheduler); locally, set `TICK_INTERVAL_MS` or send `tick` yourself.

**Audit trail.** Every decision, signal and effect is hash-chained. `{"action":"evidence","runId":"<run>"}` returns the trail and whether the chain verifies.

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=customer-kyc-rescreen STATE_FILE=.state/customer-kyc-rescreen.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs customer-kyc-rescreen
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A request starts one recorded run (provider-independent, so every later check is measured) | Executable declaration; result comes from a receipt |
| `baseline_effects` | A re-screen reads the program's accounts and posts a summary | Executable declaration; result comes from a receipt |
| `accounts_in_program_screened` | Only connected accounts in the program are screened | Executable declaration; result comes from a receipt |
| `strong_match_held` | A strong sanctions match holds payouts at once | Executable declaration; result comes from a receipt |
| `analyst_clears_false_positive` | An analyst's false-positive decision records the clearance | Executable declaration; result comes from a receipt |
| `mlro_distinct_from_analyst` | The analyst who confirmed a match can't also take the SAR decision | Executable declaration; result comes from a receipt |
| `screening_unavailable_blocks` | When screening can't run nothing is screened and compliance is told | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A program with spaces is rejected before any agent runs | Executable declaration; result comes from a receipt |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-customer-kyc-rescreen-1.0.0-befeb35`, verdict **failing**, and statuses: **2 held**, **4 unmeasured**, **2 violated**.

[Recorded receipt](https://fetchsandbox.com/runs/6c0ea91459?flow=vr_d94bf68353e54d558e1c472599f41006) · [Saved result](../../acme-ops/verify/receipts/customer-kyc-rescreen.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/customer-kyc-rescreen.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/customer-kyc-rescreen.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
