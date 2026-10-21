# Partner payout run

## Business need

Finance needs to pay every partner their monthly commission exactly once, even when a payment response is lost or the run is re-triggered, with approval for large transfers and no automation beyond a hard ceiling.

Pay the month's partner commissions by Stripe transfer to each partner's connected account. Accounts are checked and earlier transfers in the run's transfer group are found in parallel; each partner is paid at most once per run, with the same idempotency key on every retry so a lost response never becomes a second payment. Small transfers go out automatically, large ones and anything past the run limit wait for approval, and a run beyond the ceiling pays nothing. The run is recorded in Asana and posted to Slack.

Demo organization: **Acme Corporation**. Department: **Finance**. Owning team: **partner-ops**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "payoutRunId": "PO-baseline",
    "period": "2026-10",
    "partners": [
      {
        "partnerId": "P-101",
        "account": "acct_seed_baseline_1",
        "amountMinor": 120000
      },
      {
        "partnerId": "P-102",
        "account": "acct_seed_baseline_2",
        "amountMinor": 45000
      }
    ],
    "financeChannel": "C0BILLING01",
    "approvers": [
      "U_CONTROLLER"
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
| `payoutRunId` | yes | string |
| `period` | yes | string |
| `partners` | yes | array |
| `financeChannel` | yes | string |
| `financeWorkspace` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `account-check` | stripe |
| `ledger-check` | stripe |
| `payout-plan` | No direct provider requirement; uses input or prior agent results |

**3 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `stripe.transfer` | stripe | **auto** | Transfer the partner's commission to their connected account; approval above $2,500 or past the $25,000 run limit; at most once per partner per run |
| `asana.payout_record` | asana | **auto** | Payout run record for finance and audit |
| `slack.post_payout_run` | slack | **auto** | Payout run summary in the finance channel |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=partner-payout-run STATE_FILE=.state/partner-payout-run.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs partner-payout-run
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | Each partner is paid once by a transfer to their connected account; the run is recorded and posted | Executable declaration; result comes from a receipt |
| `lost_response_same_transfer` | The transfer is accepted but its response is held until the client gives up; the retry returns the same transfer and the partner is paid exactly once | Executable declaration; result comes from a receipt |
| `rerun_pays_nothing` | Re-running the same payout run (a new trigger) finds every partner already paid and pays nothing | Executable declaration; result comes from a receipt |
| `large_transfer_parked` | A transfer above $2,500 waits for approval; the small one goes out | Executable declaration; result comes from a receipt |
| `large_transfer_approved` | The controller's approval pays the large transfer exactly once | Executable declaration; result comes from a receipt |
| `large_transfer_rejected` | A rejected large transfer is never paid | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | Someone who is not an approver cannot release a transfer | Executable declaration; result comes from a receipt |
| `missing_account_skipped` | A partner whose connected account doesn't exist is skipped, not paid | Executable declaration; result comes from a receipt |
| `ceiling_halts` | A run beyond the automation ceiling pays nothing and escalates | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-delivered payout trigger pays once | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four simultaneous deliveries of one payout run pay once | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A statement listing a partner twice is rejected before any agent runs | Executable declaration; result comes from a receipt |
| `stripe_auth_failure` | Without Stripe nothing is paid; the run is still recorded and posted | Executable declaration; result comes from a receipt |
| `asana_rate_limited` | An Asana outage loses the record only; partners are still paid | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limiting fails the post only | Executable declaration; result comes from a receipt |
| `restart_while_parked` | A transfer parked for approval survives a real runtime restart and is paid once when approved | Executable declaration; result comes from a receipt |
| `transfer_reversal_readback` | Reconcile flags a transfer that was reversed after it was paid | The Stripe twin returns sample reversal fields on GET /v1/transfers/{id} (reversed: true, amount_reversed unrelated to the transfer), so the read-back can't distinguish a real reversal. Covered by local tests. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-partner-payout-run-1.0.0-b53aaba`, verdict **inconclusive**, and statuses: **15 held**, **2 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/7faac7ae96?flow=vr_3829dac008154707a381f23a625968e1) · [Saved result](../../acme-ops/verify/receipts/partner-payout-run.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/partner-payout-run.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/partner-payout-run.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
