# Supplier nonconformance and corrective action

## Business need

Supplier Quality needs an accountable corrective-action process after a failed inspection, including supplier follow-up and review scheduling.

On a rejected lot: open the CAPA in Asana with a due date by severity, draft the 8D request to the supplier, hold the review on the quality calendar and alert Purchasing; a supplier hold for critical or high-reject lots waits for approval.

Demo organization: **Acme Corporation**. Department: **Quality**. Owning team: **supplier-quality**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "ncrId": "NCR-BASELINE",
    "supplier": {
      "name": "Precision Castings",
      "email": "baseline@precision.test"
    },
    "part": "GEMS-HSG-200",
    "lot": "L2405",
    "defect": "Porosity in the housing wall above spec",
    "qtyInspected": 200,
    "qtyRejected": 2,
    "severity": "major",
    "purchasingChannel": "C0GENERAL01",
    "approvers": [
      "U_QUALITY_MGR"
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
| `ncrId` | yes | string |
| `supplier` | yes | object |
| `part` | yes | string |
| `lot` | yes | string |
| `defect` | yes | string |
| `qtyInspected` | yes | integer |
| `qtyRejected` | yes | integer |
| `severity` | yes | string / minor, major, critical |
| `qualityWorkspace` | yes | string |
| `qualityCalendarId` | yes | string |
| `purchasingChannel` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `supplier-contact` | hubspot |
| `capa-history` | asana |
| `review-slot` | calendar |

**3 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `asana.open_capa` | asana | **auto** | Open the CAPA task with the 8D due date |
| `gmail.draft_8d_request` | gmail | **auto** | Draft (not send) the 8D request to the supplier |
| `calendar.hold_8d_review` | calendar | **auto** | Hold the 8D review on the quality calendar (no attendees) |
| `slack.post_ncr` | slack | **auto** | Alert Purchasing about the rejected lot |
| `gmail.draft_supplier_hold` | gmail | **approval** | Draft the formal supplier hold notice |
| `slack.announce_hold` | slack | **approval** | Tell Purchasing to stop releasing POs |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=supplier-ncr STATE_FILE=.state/supplier-ncr.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs supplier-ncr
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A major defect at 1% rejected opens the CAPA, drafts the 8D request, holds the review and alerts Purchasing, with no hold | Executable declaration; result comes from a receipt |
| `critical_hold_parked` | A critical defect proposes a supplier hold for approval | Executable declaration; result comes from a receipt |
| `high_reject_rate_hold` | A major defect with 15% rejected also proposes a hold | Executable declaration; result comes from a receipt |
| `approve_and_reconcile` | An approved hold is drafted and announced; the CAPA is read back with its due date | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | A non-approver cannot put a supplier on hold | Executable declaration; result comes from a receipt |
| `reject` | Rejecting the hold keeps the supplier active | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-submitted NCR does not open a second CAPA | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four more simultaneous submissions create one CAPA | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | More rejected than inspected is refused before anything runs | Executable declaration; result comes from a receipt |
| `asana_auth_failure` | If Asana refuses, the CAPA fails visibly while the 8D request and alert still go out | Executable declaration; result comes from a receipt |
| `calendar_rate_limited` | Without the quality calendar no review is held; the CAPA still opens | Executable declaration; result comes from a receipt |
| `gmail_auth_failure` | A Gmail failure fails the 8D draft only | Executable declaration; result comes from a receipt |
| `restart_while_parked` | A hold parked for approval survives a runtime restart and is applied when approved afterwards | Executable declaration; result comes from a receipt |
| `repeat_supplier_escalation` | Two or more open CAPAs for the same supplier escalate to a hold | The Asana twin's task listing returns generic sample tasks, so open CAPAs per supplier can't be counted; the rule is code (holdReasons) and is unit-level only. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-supplier-ncr-1.0.0-df79afd`, verdict **inconclusive**, and statuses: **13 held**, **1 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/6479cad67b?flow=vr_cab530b56d13455182166ea403619f61) · [Saved result](../../acme-ops/verify/receipts/supplier-ncr.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/supplier-ncr.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/supplier-ncr.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
