# Workflow builder tracker

A running record of what was built in `acme-ops`, what is verified against
FetchSandbox twins, what the twin research found, and what is still pending.
Status reflects saved receipts and the dates shown; it is not a fresh run.
Update this page in the same PR as the change it describes.

Last updated: 2026-10-21.

## 1. Built and merged

| Workflow | PR | Org · team | Providers | Receipt on `main` |
|---|---|---|---|---|
| [product-cancellation](workflows/product-cancellation.md) | #65, #71, #72 | Customer Experience · cx-retention | Stripe, Zendesk, Square, Slack | **verified**, 27 held ([receipt](https://fetchsandbox.com/runs/7c141ce40b?flow=vr_1a9b707387024c149ff1ef377b55630a)) |
| [duplicate-charge-remediation](workflows/duplicate-charge-remediation.md) | #68 | Finance · billing-ops | Stripe, HubSpot, Gmail, Asana, Slack | **verified**, 23 held ([receipt](https://fetchsandbox.com/runs/942df07202?flow=vr_32045f5c19c54d8fa57cc7504523a437)) |
| [privacy-erasure](workflows/privacy-erasure.md) | #68 | Legal · privacy-ops | HubSpot, Stripe, WorkOS, Gmail, Asana, Slack | **verified**, 19 held ([receipt](https://fetchsandbox.com/runs/93969092e3?flow=vr_1fae88cbe29d455aa062b167be9977ed)) |

The other 19 Acme workflows predate this tracker (PRs #44–#61); see the
[catalog](WORKFLOWS.md). Overall: 22 workflows, 6 verified, 16 inconclusive
because of declared twin gaps, 0 receipts with a violated check.

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
| 1 | Stripe | 18 | Customers + metadata, payment intents with real charges, refunds, subscription create/cancel, quotes, balance credits, disputes linked to test charges | `Idempotency-Key` ignored on refunds and transfers (same key creates two transfers); new subscriptions stay `incomplete`, invoices can't be paid; price change and `pause_collection` ignored; seeded timestamps are junk; credit-note amounts are samples; invoices have no lines; no test clocks, no `payment_failed` lifecycle profile |
| 1 | Slack | 22 | `chat.postMessage` + 4 fault kinds | Nothing beyond posting is exercised |
| 1 | HubSpot | 18 | Contact CRUD, search, GDPR purge (MCP 0.7.30) | Custom properties rejected |
| 1 | Gmail | 17 | Draft creation | `users.messages.list` now `501`; sending never proven |
| 2 | Asana | 12 | Task create/get | Task listing returns sample data |
| 2 | Google Calendar | 6 | Insert, free/busy | `events.get` 404 right after insert |
| 2 | WorkOS | 3 | Users; membership by id; roles (0.7.30) | Membership listing by user still generic for `access-jml`; sessions are sample data |
| 2 | Zendesk | 1 | One seeded ticket: comments, status, tags (safe update) | No ticket create/search/users; `additional_tags` rejected |
| 2 | Square | 1 | Gift card create + activate | No balance; idempotency ignored; lists returned under `errors` |
| 3 | Box, Notion, PagerDuty, Twilio, GitHub | 1 each | Writes | Reads return sample data |
| — | Shopify, PayPal, Adyen, Plaid, Resend, Paddle, Sheets, Drive, Datadog | 0 | In the catalog, unused by any workflow | — |

Coverage dimensions across the 22 contracts (executable checks / 22):

| Dimension | Contracts | Note |
|---|---:|---|
| Accepted effect, response lost | **0** | Every contract defers to local tests |
| Delayed or missing events (webhooks) | **2** | No workflow consumed a webhook |
| Ordering / stale events | 8 | Mostly not applicable: triggers are direct calls |
| Data and privacy boundaries | 6 | Mostly stated, not measured |
| Amount / currency / quantity | 10 | USD only; no test clocks |
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

## 4. In progress

| Workflow | Gap it proves | Status |
|---|---|---|
| `paid-order-provisioning` | Webhooks: signature, mutated body, old replay, duplicate and concurrent delivery, stale events, withheld-webhook recovery | Building. Replaces the planned dunning workflow, which the twin can't drive (no clock, no failed-payment lifecycle) |
| `partner-payout-run` | Accepted effect / response lost; idempotency on money-out | Building. The twin ignores `Idempotency-Key` on transfers, so the workflow must find its own earlier transfer before retrying |

## 5. Backlog

| Item | Why | Blocked on |
|---|---|---|
| Fix `churn-risk-sweep` and `field-service-dispatch` contracts | Re-proof regressions above | Owner go-ahead |
| Refresh `acme-ops/README.md` "Relay proofs" paragraph | Still cites the 20/16 receipts | — |
| AI support triage (Claude-drafted replies, prompt injection) | Model path never measured | Runner eval mode; Gmail list `501`; Zendesk create/search |
| Cross-border refund (multi-currency, tax) | Currency dimension | Stripe test clocks |
| Account-takeover containment | Session revocation, membership listing | WorkOS sessions/memberships twins |
| Cross-workflow race on one customer | Concurrency across runtimes | — |
| Sweep at scale (5k+ records) | Pagination, rate limits | Faithful `has_more` |
| Order-to-cash with shipping | ERP and carrier twins | New twins |
| Failed-payment dunning | Clock-driven lifecycle | Stripe test clocks / `payment_failed` profile |
