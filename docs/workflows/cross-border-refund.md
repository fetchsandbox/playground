# Cross-border refund

## Business need

Customer Experience needs to refund international customers in the currency they paid, only to the customer who paid, with currency-aware limits and without letting ticket text decide the amount.

Refund a Zendesk refund request in the currency the customer paid: the requester must be the paying customer, disputed or over-refunded payments go to a person, per-currency limits (zero- and three-decimal aware) gate approval, ticket text is never trusted for amounts, and store credit falls back to the card when the balance currency differs.

Demo organization: **Acme Corporation**. Department: **Customer Experience**. Owning team: **global-support**. Configure your own named owner and approvers when deploying; repository examples do not grant access to Acme or FetchSandbox accounts.

## Trigger and result

The runtime accepts the `start` command through `POST /invocations`. The baseline below is an executable-contract example using synthetic twin identifiers, not live customer data. Automatic Slack/email/scheduled intake requires a separately configured adapter; an input schema alone does not establish that intake is deployed.

```json
{
  "action": "start",
  "runId": "baseline-{{run_id}}",
  "input": {
    "ticketId": 900000,
    "paymentIntent": "pi_seed_baseline",
    "supportChannel": "C0SUPPORT01",
    "approvers": [
      "U_SUPPORT_LEAD"
    ],
    "locale": "de"
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
| `ticketId` | yes | integer |
| `paymentIntent` | yes | string |
| `method` | yes | string / original_payment, store_credit |
| `amountMinor` | no/default | integer |
| `currency` | no/default | conditional |
| `locale` | no/default | string |
| `supportChannel` | yes | string |
| `approvers` | no/default | array |

## Agents and responsibilities

| Role | Required provider clients |
|---|---|
| `ticket-intake` | zendesk |
| `payment-check` | stripe |
| `refund-decision` | No direct provider requirement; uses input or prior agent results |

**3 declared roles**, including the compose stage where present. These are logical responsibilities, not a count of independent models or servers.

## Policies, writes and approval boundaries

Every possible action kind is declared below. `auto` means the workflow may perform it without a human gate after its business conditions pass; it does not mean it always runs. `approval` means the configured approver must decide. Read the linked workflow source for eligibility, thresholds and input-dependent branches. Never copy one workflow’s discount/refund rules into another.

| Action | Provider | Gate | Business effect |
|---|---|---|---|
| `stripe.refund` | stripe | **auto** | Refund the payment in its own currency; approval above the currency's limit, for old payments or instruction-like request text |
| `stripe.store_credit` | stripe | **auto** | Credit the customer's Stripe balance instead, only in the balance's own currency |
| `zendesk.reply` | zendesk | **auto** | Public reply with the locale-formatted amount, solving the ticket, only after the money moved |
| `zendesk.internal_note` | zendesk | **auto** | Internal note with the decision for support agents |
| `slack.post_refund` | slack | **auto** | Decision in the support channel |

## Setup and run

From the repository root:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
WORKFLOW=cross-border-refund STATE_FILE=.state/cross-border-refund.json node --env-file=.env dist/main.mjs
```

Create a private `.env` using the package setup guide. Set only credentials and provider URLs for your own sandbox/test accounts. Optional LLM drafting needs your model-service key; a template run is not an LLM evaluation. Missing provider credentials must stay visible as skipped/not configured. See the [shared setup and deployment guide](../../acme-ops/README.md#run-locally).

The sample requires the isolated twin fixtures created by its contract. Do not send the sample identifiers to production. For live-vendor testing, prepare your own customer, product, ticket and approver identities and obtain any required access.

## FetchSandbox verification

Coding agents must follow the [repository verification instructions](../../AGENTS.md) and [verification guide](../VERIFICATION.md), including contract scope, independent observations and explicit blockers.

```bash
cd acme-ops
npm run bundle
node verify/relay-proof.mjs cross-border-refund
```

This makes network calls, creates isolated twin resources and consumes FetchSandbox usage. It needs FetchSandbox authentication and managed-relay access. It does not deploy to AWS or authorize live customer communication.

### Declared scenarios

| Check | Business behavior | Contract blocker |
|---|---|---|
| `baseline` | A EUR payment is refunded in EUR to the customer who paid; the public reply carries the amount, the ticket is solved and the decision noted and posted | Executable declaration; result comes from a receipt |
| `jpy_zero_decimal_auto` | A ¥12,000 payment is refunded as 12000 yen (zero-decimal, not ×100) automatically | Executable declaration; result comes from a receipt |
| `jpy_over_limit_parked` | A ¥90,000 refund is above the ¥75,000 automatic limit: it waits for approval and the customer hears nothing yet | Executable declaration; result comes from a receipt |
| `jpy_over_limit_approved` | The support lead's approval refunds ¥90,000 once and then replies | Executable declaration; result comes from a receipt |
| `jpy_over_limit_rejected` | A rejected refund is never paid and never announced | Executable declaration; result comes from a receipt |
| `approve_by_stranger_refused` | Someone who is not an approver cannot release a refund | Executable declaration; result comes from a receipt |
| `partial_refund` | A partial GBP refund refunds exactly the requested part | Executable declaration; result comes from a receipt |
| `over_refund_review` | A request for more than the payment refunds nothing and goes to a person | Executable declaration; result comes from a receipt |
| `currency_mismatch_review` | A request expecting USD for a EUR payment is never converted: a person follows up | Executable declaration; result comes from a receipt |
| `requester_mismatch_review` | A ticket filed by someone other than the paying customer moves no money | Executable declaration; result comes from a receipt |
| `disputed_payment_review` | A disputed payment is not refunded (the card network decides) | Executable declaration; result comes from a receipt |
| `store_credit_same_currency` | Store credit for a USD payment is credited to the USD customer balance; the card is not refunded | Executable declaration; result comes from a receipt |
| `store_credit_currency_fallback` | Store credit can't hold EUR on a USD balance: the EUR payment is refunded to the card instead, with the reason | Executable declaration; result comes from a receipt |
| `instruction_text_parked` | Ticket text that instructs the automation changes nothing but the gate: the amount comes from Stripe and a person approves | Executable declaration; result comes from a receipt |
| `rerun_moves_no_money` | A second request for the same ticket and payment (a new trigger) finds the refund and moves no money | Executable declaration; result comes from a receipt |
| `duplicate_start` | A re-delivered request refunds once | Executable declaration; result comes from a receipt |
| `concurrent_start` | Four simultaneous deliveries of one request refund once | Executable declaration; result comes from a receipt |
| `operator_refund_first` | A payment an operator already refunded in full gets nothing more | Executable declaration; result comes from a receipt |
| `operator_refund_while_parked` | An operator's full refund while approval is parked stops the approved refund and its reply | Executable declaration; result comes from a receipt |
| `stripe_auth_failure` | Without Stripe nothing is refunded; the ticket gets a note and Slack a warning | Executable declaration; result comes from a receipt |
| `zendesk_rate_limited` | When the ticket can't be read, nothing is refunded (fail closed) and Slack is told | Executable declaration; result comes from a receipt |
| `slack_rate_limited` | Slack rate limiting fails the post only; the refund and reply go out | Executable declaration; result comes from a receipt |
| `restart_while_parked` | A refund parked for approval survives a real runtime restart and is paid once when approved | Executable declaration; result comes from a receipt |
| `reconcile_reads_refund` | Reconcile reads the refund back from Stripe and finds it as written | Executable declaration; result comes from a receipt |
| `invalid_input_rejected` | A request with a malformed payment id is rejected before any agent runs | Executable declaration; result comes from a receipt |
| `locale_from_zendesk` | Amounts are formatted in the requester's Zendesk locale when the request names none | The Zendesk twin keeps no user locale: tickets whose requester carries `locale` are rejected ("A valid requester email is required") and PUT /api/v2/users/{id}.json is 404, so contracts pass the locale in the request. The Zendesk-locale path is covered by local tests. |
| `tax_portion_refund` | The VAT/GST share of a refund is reversed with the right tax rate per country | The Stripe twin's tax calculations return sample data, so a tax reversal can't be asserted. The workflow refunds the gross amount the customer paid and does not compute tax itself. |
| `settlement_fx_readback` | The refund's settlement-currency amount and exchange rate are read back for finance | Refunds on the Stripe twin have balance_transaction null and no exchange rates, so the settlement leg of a cross-currency refund is not observable. |

### Saved evidence — historical, not a fresh run

The checked-in receipt records app version `acme-ops-cross-border-refund-1.0.0-6670912`, verdict **inconclusive**, and statuses: **25 held**, **3 unmeasured**.

[Recorded receipt](https://fetchsandbox.com/runs/a5b21ce399?flow=vr_57e4df0485364ea1880182c6b4c04ee6) · [Saved result](../../acme-ops/verify/receipts/cross-border-refund.json)

Blocked reasons above describe this contract revision. They can become stale when a twin gains a capability; reassess discovery and configure a new measured run before claiming the blocker resolved. Passing leaves do not override an inconclusive receipt. Twin proof does not certify live OAuth consent, SMTP delivery, deployed adapters or every production failure.

## Source and contract

- [Workflow and business rules](../../acme-ops/src/workflows/cross-border-refund.ts)
- [Executable verification contract](../../acme-ops/verify/contracts/cross-border-refund.mjs)
- [Shared state, approval and recovery engine](../../acme-ops/src/kit/engine.ts)

<!-- Generated by scripts/workflow_docs.py from workflow definitions, contracts and saved receipts. Edit source or the business-need mapping, then regenerate. -->
