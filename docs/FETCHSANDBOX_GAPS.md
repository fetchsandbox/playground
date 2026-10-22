# FetchSandbox gap report

What FetchSandbox could prove for the acme-ops workflows, what it could not,
and what FetchSandbox would need to build to close each gap. Every claim
points to a receipt check or a recorded probe. Probes and runs were made on
2026-10-22 with `fetchsandbox-mcp@0.7.30`; the twins change often, so re-probe
before relying on a "not supported" line.

## How this was measured

- Four workflows were built specifically to exercise areas the earlier
  research flagged as weak: an LLM-backed support triage, a failed-payment
  dunning ladder, a data sweep over hundreds of customers, and an
  order-to-cash flow across a storefront, an ERP and a carrier.
- Each was written the way a production runtime would be (real vendor API
  paths, code-side guards, fail-closed behaviour) and proven locally against a
  faithful fake (`acme-ops/test/fake-world.ts`).
- Their FetchSandbox contracts state the business behaviour as **ordinary
  executable checks**, including the behaviour the twins were expected to be
  unable to support. Nothing was declared blocked in advance. The receipt then
  shows, check by check, what FetchSandbox could and could not measure.
- Before the contracts, each twin surface was probed directly (raw requests
  against a validation session's twin) so a failing check can be traced to the
  twin behaviour that caused it.

## Results

_Receipts for failed-payment-dunning, customer-data-sweep and order-to-cash are still running (FetchSandbox tunnel allowance); ai-support-triage: 18 held, 3 violated (the model checks), receipt https://fetchsandbox.com/runs/8b707a425c?flow=vr_7609225e94cb4126a1649d0772bd8bb1. This section is completed when the remaining receipts land._

## Requirements for FetchSandbox

Ordered by how many enterprise workflows each unblocks. "Accept when" is the
smallest observable behaviour that would turn the named checks from violated
or unmeasured into measured.

| # | Requirement | Unblocks | Evidence today | Accept when |
|---|---|---|---|---|
| R1 | **LLM twin with scripted, schema-shaped completions.** OpenAI Chat Completions (and Anthropic Messages) twins that return a contract-supplied answer per request (e.g. keyed by a prompt fingerprint or a fixture id), as role `assistant`, honouring `response_format: json_object`. Keep the existing fault scenarios. | ai-support-triage `model_answers_how_to`, `model_classifies_billing`, `model_answer_validated`; every Claude-drafting path in the repo | OpenAI twin returns `"Sample content"`, role `system`, `finish_reason: "sample-value"`; `POST /v1/responses` 404; Cohere returns no text; `anthropic` is an unknown provider | A contract can say "for this ticket the model answers `{...}`" and the runtime receives exactly that as the assistant message; an unsafe scripted answer lets the code-side refusal be measured |
| R2 | **Stripe time and failed-collection lifecycle.** Test clocks (create/advance), invoices that carry their invoice items, `finalize` leaving the invoice `open` with `amount_due`, `POST /invoices/{id}/pay` that fails with the customer's failing card and increments `attempt_count`, `invoice.payment_failed` events, and a `payment_failed` lifecycle profile for `provider_lifecycle`. | failed-payment-dunning (all ladder checks), renewals, trial expiry | test clocks 501 "does not simulate the passage of time"; invoice items not attached (finalize → `paid`, `amount_due` 0, `lines` []); invoice `pay` 501 "Invoice action is not simulated"; invoice with `subscription` 501 "Invoice option is not simulated"; lifecycle profiles only `accept_payment`, `create_and_send_invoice` | A seeded invoice can be `open` with `attempt_count` 1..3 and an age of 14+ / 21+ days, and the provider assertion `invoices: status=open, attempt_count=N` holds |
| R3 | **Faithful cursor pagination and bulk fixtures.** `has_more` true while records remain, `starting_after` advancing, search honouring its query; a bulk-seed call (or a fixture size parameter) that can create thousands of records in seconds. | customer-data-sweep `full_scan_250`; any sweep over real-sized accounts | `has_more` always false; `starting_after` ignored (page 2 = page 1); `/customers/search` ignores the query; seeding ≈ 0.6 s per customer, so 5,000 customers ≈ 50 minutes | A 250-customer segment is read in three pages and the 5,000-record sweep can be seeded in under a minute |
| R4 | **ERP twin (NetSuite SuiteTalk REST first; SAP/Oracle later).** Sales orders with external id, items and status; 204 + `Location` on create; query by external id. | order-to-cash `sales_order_booked_in_erp`; order-status `erp_order_lines`; field-service-dispatch `parts_reservation` | `validate_integration(providers:["netsuite"])` → "Unknown providers: netsuite" | The order-to-cash session can include `netsuite` and the sales order is asserted on the twin |
| R5 | **Carrier twin (EasyPost or Shippo).** Shipments with rates, `buy` returning a tracking code, idempotent second buy refused, tracking events. | order-to-cash `label_bought_under_limit`, `customer_gets_tracking`; returns-warranty `carrier_return_label`; order-status `carrier_tracking` | "Unknown providers: easypost" / "shippo" | A label is bought once and its tracking code appears on the Shopify fulfillment |
| R6 | **Shopify Admin twin on current API versions with stateful orders.** Versions within Shopify's support window (2024-xx/2025-xx), order create/get/list with the id inside the order, computed `total_price`/`financial_status`/`fulfillment_status`, fulfillments scoped to their order and listed under `fulfillments`. | order-to-cash `shipped_order_not_shipped_again` and the whole storefront leg | only 2020-01…2021-01 + `unstable`; `POST orders` only in 2020-01/2020-04; response `{order:<echo>, id:<outside>}`; `GET orders.json` → `{"orders.json": []}`; fulfillment list keyed `"fulfillments.json"`, includes samples and other orders' fulfillments | `GET /admin/api/2024-10/orders/{id}/fulfillments.json` returns only that order's fulfillments under `fulfillments` |
| R7 | **External-operator input for more provider writes** — at least Stripe customer metadata, so a contract can stage "another system changed this record while the run was parked". | cross-border-refund `takeover_hold_while_parked`; any cross-workflow race | "Provider operation is not qualified as an external operator input" (configuration refused) | The operator write lands between a parked run's planning and its approval |
| R8 | **WorkOS sessions and membership lifecycle.** Real sessions per user under `data`, revoke that removes them; membership deactivate/reactivate; stored role updates; no sample records without `user_id` in the observation collection. | account-takeover-containment `sessions_revoked`; access-jml | sessions are samples under `items`, revoke echoes any id; deactivate 404, reactivate echoes; role update echoed but not stored | A revoked session disappears from the user's list and the provider assertion can filter memberships by `user_id` |
| R9 | **Zendesk user locale and search.** Requester `locale` on ticket create and user update; `GET /users/{id}.json` wrapped in `user`; Search API. | cross-border-refund `locale_from_zendesk`; ticket dedupe by search | requester with `locale` → "A valid requester email is required"; user PUT 404; search 404 | The ticket's requester has `locale: "de"` and the runtime formats `123,45 €` without being told |
| R10 | **Stripe tax and settlement data.** Tax calculations for real line items and refunds' balance transactions with exchange rates. | cross-border-refund `tax_portion_refund`, `settlement_fx_readback` | tax calculations return samples; refund `balance_transaction: null` | A EUR refund on a USD account has a balance transaction with `exchange_rate` |
| R11 | **Measure response loss through a proxy.** Witness the client's abort even when the client sits behind an egress proxy (or offer a mode that observes the retry by Idempotency-Key instead of the TCP disconnect). | partner-payout-run `lost_response_same_transfer` | "disconnect witnesses=0" from this cloud sandbox | The same check holds from a proxied runtime |
| R12 | **Correlate webhook-started runs to a check.** Pass the check id on signed deliveries (e.g. an `X-FetchSandbox-Case` header beside `X-Flow-Run-Id`) so runtimes can label event-started runs for observation. | failed-payment-dunning event path; any webhook-first workflow | event-started runs carry only `X-Flow-Run-Id`; the dunning contract had to start the stage directly | A signed `invoice.payment_failed` delivery's run appears in that check's runs view |
| R13 | **Bigger or clearer tunnel allowance.** Back-to-back proofs (or a proof after a failed seed) hit "Managed tunnel capacity reached … allowance for your IP" for tens of minutes. | every proof loop | observed repeatedly on 2026-10-22 | A second proof can start within a minute of the previous one ending |
| R14 | **Missing twins named by earlier receipts:** restricted-party screening (Trade.gov CSL), Statuspage, Salesforce CPQ, Google Workspace Admin / SCIM, license-cost data; and faithful read-backs on Box search, Notion database query, Asana task listing, Calendar `events.get`, PagerDuty notes, Stripe credit notes, transfer reversals and invoice lines. | see the earlier-receipts table below | each receipt's explanation | per twin |

## Engine and contract findings (not twin data)

- A check whose assertion is a single leaf (`repeat: 2`) is **driven twice**;
  a one-shot operator write (a full refund) then returns 400 on the second
  drive. Wrap such checks in `all_of` to drive them once.
- The first check must be plain HTTP (no signed event).
- Accepted blocked categories are `setup_missing` and `observation_missing`;
  `capability_missing` and `fixture_unsupported` are refused.
- `errorCode` can't be observed as a required field; provider-state filters
  fail when any record (including twin samples) lacks the field.
- Seeding happens before the run id exists, so fixtures can't be keyed to it.

