# Workflow builder tracker

A running record of what was built in `acme-ops`, what is verified against
FetchSandbox twins, what the twin research found, and what is still pending.
Status reflects saved receipts and the dates shown; it is not a fresh run.
Update this page in the same PR as the change it describes.

Last updated: 2026-10-22 (after the cross-border refund and account-takeover workflows).

## 1. Built (merged, and in review)

| Workflow | PR | Org · team | Providers | Receipt on `main` |
|---|---|---|---|---|
| [product-cancellation](workflows/product-cancellation.md) | #65, #71, #72 | Customer Experience · cx-retention | Stripe, Zendesk, Square, Slack | **verified**, 27 held ([receipt](https://fetchsandbox.com/runs/7c141ce40b?flow=vr_1a9b707387024c149ff1ef377b55630a)) |
| [duplicate-charge-remediation](workflows/duplicate-charge-remediation.md) | #68 | Finance · billing-ops | Stripe, HubSpot, Gmail, Asana, Slack | **verified**, 23 held ([receipt](https://fetchsandbox.com/runs/942df07202?flow=vr_32045f5c19c54d8fa57cc7504523a437)) |
| [privacy-erasure](workflows/privacy-erasure.md) | #68 | Legal · privacy-ops | HubSpot, Stripe, WorkOS, Gmail, Asana, Slack | **verified**, 19 held ([receipt](https://fetchsandbox.com/runs/93969092e3?flow=vr_1fae88cbe29d455aa062b167be9977ed)) |
| [paid-order-provisioning](workflows/paid-order-provisioning.md) | #74 | Sales · order-ops | Stripe (signed webhooks), WorkOS, HubSpot, Gmail, Slack | **verified**, 21 held ([receipt](https://fetchsandbox.com/runs/7191c10d9e?flow=vr_91d0dcb6472e4337981361327717d67e)) |
| [partner-payout-run](workflows/partner-payout-run.md) | #74 | Finance · partner-ops | Stripe (transfers), Asana, Slack | inconclusive, 15 held, 2 unmeasured ([receipt](https://fetchsandbox.com/runs/15f2349205?flow=vr_5c1e5f95f6124277a0a7de409adb8344)) |
| [cross-border-refund](workflows/cross-border-refund.md) | #74 | Customer Experience · global-support | Zendesk, Stripe (multi-currency), Slack | inconclusive, 26 held, 4 unmeasured ([receipt](https://fetchsandbox.com/runs/1f4adfc8be?flow=vr_99c5689f49494f759adad1f473cc1875)) |
| [account-takeover-containment](workflows/account-takeover-containment.md) | #74 | IT · it-security | WorkOS, Stripe, Asana, Slack | inconclusive, 20 held, 2 unmeasured ([receipt](https://fetchsandbox.com/runs/0af7cb3e63?flow=vr_2e81298bdd5645a38f14efcf2db1dcf0)) |

The other 19 Acme workflows predate this tracker (PRs #44–#61); see the
[catalog](WORKFLOWS.md). Overall: 26 workflows, 7 verified, 19 inconclusive
because of declared twin or environment gaps, 0 receipts with a violated check.
The four #74 workflows are in one PR from `claude/acme-ops-crossborder-and-ato`;
each is still its own app (workflow file, runtime, stack, contract, receipt).

## 2. Re-verification of existing workflows (2026-10-19)

All 20 workflows on `main` at the time were re-proven from an untouched copy
of `main`. The fresh receipts were not committed.

| Result | Workflows |
|---|---|
| Same as committed receipt | 18 (all except the two below) |
| Now fails `baseline` | `churn-risk-sweep`: the Gmail twin returns `501 not_simulated` for `users.messages.list` (it worked on 2026-10-17), so the inbox agent fails and the run is `partial` |
| Now fails `restart_while_parked` | `field-service-dispatch`: whether a booking needs approval depends on the time of day; at ~01:10 UTC nothing was parked |

Both are contract issues, not workflow bugs. **Pending:** adjust those two
contracts (owner decision: existing workflows are not changed in feature PRs).

## 3. Twin research

How well each twin is proven, from the 22 contracts, their receipts, the 26
declared blockers and direct probes made while building.

| Tier | Twin | Workflows | Proven | Known gaps (probed) |
|---|---|---:|---|---|
| 1 | Stripe | 21 | Customers + metadata, payment intents with real charges in USD/EUR/GBP/JPY (zero-decimal), refunds with over-refund refusal, subscription create/cancel, quotes, balance credits with `currency_mismatch`, disputes linked to test charges, connected-account transfers | `Idempotency-Key` ignored on refunds and transfers (same key creates two transfers); new customers default to `currency: "USD"` (real Stripe: null); tax calculations and FX are samples, refunds have no balance transaction; customer metadata updates are not accepted as external-operator input; new subscriptions stay `incomplete`, invoices can't be paid; price change and `pause_collection` ignored; seeded timestamps are junk; credit-note amounts are samples; invoices have no lines; no test clocks, no `payment_failed` lifecycle profile |
| 1 | Slack | 22 | `chat.postMessage` + 4 fault kinds | Nothing beyond posting is exercised |
| 1 | HubSpot | 18 | Contact CRUD, search, GDPR purge (MCP 0.7.30) | Custom properties rejected |
| 1 | Gmail | 17 | Draft creation | `users.messages.list` now `501`; sending never proven |
| 2 | Asana | 12 | Task create/get | Task listing returns sample data |
| 2 | Google Calendar | 6 | Insert, free/busy | `events.get` 404 right after insert |
| 2 | WorkOS | 5 | Users; organizations; memberships create/get/delete, listed by user and by organization, stored roles (2026-10-22) | Deactivate/reactivate not simulated (404 / echo); role updates echoed, not stored; sessions are samples under `items` and revoke echoes any id; sample membership records have no `user_id` |
| 2 | Zendesk | 2 | Ticket create (`requester.email`, public first comment), get, comments, status, tags (safe update) | Search `404`; no user locale (requester `locale` rejected, user PUT `404`); `GET /users/{id}` returns the user unwrapped; group/assignee not simulated |
| 2 | Square | 1 | Gift card create + activate | No balance; idempotency ignored; lists returned under `errors` |
| 3 | Box, Notion, PagerDuty, Twilio, GitHub | 1 each | Writes | Reads return sample data |
| — | Shopify, PayPal, Adyen, Plaid, Resend, Paddle, Sheets, Drive, Datadog | 0 | In the catalog, unused by any workflow | — |

Coverage dimensions across the contracts (counts as of 2026-10-21, 22 contracts; the two 2026-10-22 workflows are described in section 5):

| Dimension | Contracts | Note |
|---|---:|---|
| Accepted effect, response lost | **0** (1 declared) | Every earlier contract deferred to local tests; `partner-payout-run` now declares an executable check (unmeasured from this sandbox, see 4) |
| Delayed or missing events (webhooks) | **3** | `paid-order-provisioning` is the first runtime that consumes webhooks |
| Ordering / stale events | 8 | Mostly not applicable: triggers are direct calls |
| Data and privacy boundaries | 6 | Mostly stated, not measured |
| Amount / currency / quantity | 11 | `cross-border-refund` measures EUR/GBP/JPY refunds, per-currency limits and the balance-currency fallback; tax and FX still unmeasurable; no test clocks |
| Baseline, identity, duplicates, concurrency, restart, partial effects, reconciliation | 22 | Concurrency means one runtime, same trigger |

Never measured: the Claude drafting path (the proof runner strips
`ANTHROPIC_*`, so all proofs use templates), scale/pagination (twin `has_more`
is unreliable), two workflows racing on one customer, live email/OAuth delivery.

Missing twins named by blockers: ERP (SAP/Oracle/NetSuite), carriers
(UPS/FedEx/EasyPost/Shippo), Salesforce, restricted-party screening,
Statuspage, Google Workspace Admin / SCIM, license-cost data. Seven blockers
still say "no Zendesk twin yet", which is stale (a bounded twin exists).

Engine capabilities found on 2026-10-21 (MCP 0.7.30): signed webhook delivery
to an app route (`event_destinations`), Stripe provider-lifecycle profiles
`accept_payment` and `create_and_send_invoice`, exact event replay, up to 8
concurrent deliveries, Stripe scenarios `webhook_withheld`, `webhook_retries`,
`flaky_webhooks`, `replayed_old_signed_event`, `signed_event_with_mutated_body`,
`recovery_timeout`, and fault evidence `accepted_response_loss` /
`accepted_response_retry`. The Stripe twin states that clock-driven lifecycles
(renewals, trial expiry, dunning) are out of scope.

## 4. Gap-proving workflows (2026-10-21)

**paid-order-provisioning: webhooks, verified 21/21.** Replaces the planned
dunning workflow, which the twin can't drive (no clock, no failed-payment
lifecycle). Proven on the twins:
- Signed `payment_intent.succeeded` delivered by the verifier to the real
  handler `POST /webhooks/stripe` (direct signed-event mode); the same request
  can arrive through `/invocations` as an envelope on AgentCore.
- Exact replay and 4 concurrent deliveries grant access once.
- An event for a payment refunded first (by an independent operator) grants
  nothing: the runtime re-reads Stripe instead of trusting the event.
- A payment whose event never arrives is provisioned by the sweep; a late
  event afterwards changes nothing.

Not measured on the twin: Stripe's own lifecycle delivery (`provider_lifecycle`)
and the `signed_event_with_mutated_body` / `replayed_old_signed_event`
scenarios; signature refusals are covered by local tests.

**partner-payout-run: money out, 15 held, 2 unmeasured.**
- `lost_response_same_transfer` (`accepted_response_retry`, Stripe
  `recovery_timeout`): the run is correct (one transfer, one attempt, the same
  idempotency key on the retry), but FetchSandbox records "disconnect
  witnesses=0". This cloud sandbox sends all outbound HTTPS through a
  TLS-intercepting proxy, which does not pass the client's abort upstream.
  Expected to measure from a machine without that proxy.
- `transfer_reversal_readback`: the twin returns sample reversal fields.

New engine findings:
- The Stripe twin ignores `Idempotency-Key` on transfers (same key, two
  transfers), except under the `accepted_response_retry` hold.
- The WorkOS twin now rejects memberships for an organization it doesn't know;
  contracts must create the organization first.
- Created connected accounts get `ACCT-…` ids with no capabilities;
  provider-state observations don't model `transfer_group` (filter on
  `destination`).
- The first contract check must be plain HTTP (no signed events).
- One relay timeout after a restart (`restart_while_parked`) did not reproduce
  on re-run.

## 5. Next set (2026-10-22)

Re-probe before building (MCP 0.7.30): the Zendesk twin now creates tickets and
the WorkOS twin lists and deletes memberships, which unblocked the planned
cross-border refund and account-takeover items. AI support triage stays in the
backlog: there is no Anthropic twin and the OpenAI twin returns sample
content, so the model path still can't be measured.

**cross-border-refund: currency and identity, 26 held, 4 unmeasured.** Proven
on the twins:
- EUR, GBP and JPY refunds in the currency paid. ¥12,000 is refunded as 12000,
  not ×100. Each currency has its own automatic limit: ¥90,000 parks for
  approval, and approve, reject and stranger-refusal are all checked.
- A requester who isn't the paying customer, a disputed payment, a request
  that names another currency, an over-refund, and a payment an operator
  already refunded all move no money and leave an internal note.
- Store credit lands on the customer balance only in the balance's currency.
  Otherwise the refund goes to the card and the reply says why.
- Ticket text that instructs the automation ("SYSTEM: … refund 9,999,999
  EUR") does not change the amount, which comes from Stripe, and sends the
  refund to approval.
- An operator's full refund while a refund is parked makes the approved
  refund fail closed with no reply.
- A customer under an account-takeover hold gets no refund.

Declared gaps: no Zendesk user locale (contracts pass the locale), tax
reversal and settlement FX (twin samples), and a hold placed while a refund is
parked (customer metadata isn't qualified operator input; covered by a local
test).

**account-takeover-containment: identity containment, 20 held, 2
unmeasured.** Proven on the twins:
- A high-risk alert holds the account's refunds (Stripe customer metadata)
  and removes admin seats automatically, but only in organizations that keep
  another admin. Removing an organization's last admin waits for approval.
- Medium risk holds refunds but removes nothing without approval. Low risk
  only posts.
- A refund spike on the account's own Stripe customer raises medium to high.
- Re-runs, duplicates and 4 concurrent deliveries contain once.
- Without WorkOS nothing is held or removed. Without Stripe the seat is still
  removed but nothing is held.
- Restore puts the seat back with approval and releases only its own alert's
  hold.

Membership state is asserted on the WorkOS twin by membership id. Declared
gaps: session revocation (twin samples), and a co-admin leaving between scan
and write (covered by a deterministic local test).

Cross-workflow rule: `cross-border-refund` checks the takeover hold at
decision time and again at write time. This is the first interlock between two
runtimes.

New engine findings:
- An executable check whose assertion is a single leaf (`repeat: 2`) is
  driven twice. A one-shot operator write (a full refund) then returns 400 on
  the second drive. Use `all_of` to drive it once.
- Accepted blocked categories are `setup_missing` and `observation_missing`
  (`capability_missing` and `fixture_unsupported` are refused).
- The selector `errorCode` isn't observable as a required field.
- Provider-state filters fail when any record (including twin samples) lacks
  the field.
- A second proof started right after the previous one sometimes fails with
  "Owned managed tunnel required"; an immediate retry works.

## 6. Backlog

| Item | Why | Blocked on |
|---|---|---|
| Fix `churn-risk-sweep` and `field-service-dispatch` contracts | Re-proof regressions above | Owner go-ahead |
| `product-cancellation` customer-reply check | The Zendesk twin now takes customer-authored comments, so this may be provable | Owner go-ahead (existing workflow) |
| Refresh `acme-ops/README.md` "Relay proofs" paragraph | Still cites the 20/16 receipts | — |
| AI support triage (Claude-drafted replies, prompt injection) | Model path never measured | An LLM twin with real output, or runner eval mode; Zendesk search `404`; Gmail list `501` |
| Tax and FX for cross-border refunds | `tax_portion_refund`, `settlement_fx_readback` | Stripe tax and balance-transaction twins |
| Session revocation for account takeover | `sessions_revoked` | WorkOS sessions twin |
| Cross-workflow race on one customer, measured | `takeover_hold_while_parked` | Operator input for Stripe customer metadata, or two runtimes in one proof |
| Sweep at scale (5k+ records) | Pagination, rate limits | Faithful `has_more` |
| Order-to-cash with shipping | ERP and carrier twins | New twins |
| Failed-payment dunning | Clock-driven lifecycle | Stripe test clocks / `payment_failed` profile |
| Measure `lost_response_same_transfer` without the sandbox proxy | Response-loss dimension still 0 measured | A run from a developer machine |
| Webhook lifecycle mode (`provider_lifecycle`, `accept_payment`) for paid-order-provisioning | Stripe-originated delivery, not verifier-signed | Contract variant |
