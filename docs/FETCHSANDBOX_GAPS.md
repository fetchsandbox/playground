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

Each row is one checked-in receipt (`acme-ops/verify/receipts/<workflow>.json`,
app version in the receipt). "Proved" lists what FetchSandbox measured as held;
"Not proved" names the check ids that were violated or unmeasured and the cause
traced in the runtime log. A violated check here is a **FetchSandbox gap unless
the cause column says otherwise**; the same checks pass locally against the fake.

| Workflow | App version | Held / violated / unmeasured | Proved on twins | Not proved, and why | Needs |
|---|---|---|---|---|---|
| ai-support-triage | 3abd028 | 18 / 3 / 0 | Zendesk read and tagging, Slack, rate-limit and auth faults, guarded fallbacks | `model_answers_how_to`, `model_classifies_billing`, `model_answer_validated`: the OpenAI twin answers `"Sample content"` as role `system` | R1 |
| cross-border-refund | 78468f6 | 26 / 0 / 4 | Stripe refunds with idempotency, approval gates, Zendesk notes, faults | `locale_from_zendesk`, `tax_portion_refund`, `settlement_fx_readback`, `takeover_hold_while_parked` | R7, R9, R10 |
| account-takeover-containment | 40b5cbb | 20 / 0 / 2 | WorkOS reads, Stripe holds, approval, faults | `sessions_revoked` and membership deactivation | R8 |
| failed-payment-dunning | ed90f18 | 5 / 3 / 2 | Stage entry, Slack, invoice-not-found and auth faults | `first_failure_card_update_notice`, `second_failure_tries_backup_card` (no `attempt_count`), `final_notice_after_14_days`, `cancellation_needs_approval`, `repeated_failure_no_second_notice`: invoices can't be open/failed, no time | R2, R15 |
| order-to-cash | ed90f18 | 6 / 4 / 0 | Shopify order read (2020-04), cancelled and unpaid orders skipped, Shopify 429 | `sales_order_booked_in_erp`, `label_bought_under_limit`, `customer_gets_tracking`, `shipped_order_not_shipped_again`: no NetSuite or EasyPost twin | R4, R5, R6 |
| supplier-bank-change | ed90f18 | 4 / 5 / 4 | Intake, invalid input, Slack fault | `payments_held_while_verifying`, `callback_to_number_on_file`, `ownership_checked_with_plaid`, `sanctions_screened`, `callback_deadline_rejects`; the four signal checks got 404 because nothing was planned: the vendor record lives in NetSuite and screening has no twin | R4, R14, R15 |
| user-access-review | ed90f18 | 8 / 4 / 0 | WorkOS org memberships per entitlement, owner and self-review rules, Asana evidence, faults | `campaign_covers_every_system`, `github_member_revoked` (GitHub twin: `GET /orgs/{org}/members` → "Unknown method"), `deadline_revokes_unreviewed_admin`, `reminder_only_for_open_items` (need time) | R15, R18 |
| employee-offboarding | ed90f18 | 5 / 5 / 0 | WorkOS inventory, EasyPost-free paths, Slack | `termination_filed`, `payroll_approval_pays`, `deadline_pays_without_approval`, `rescission_undoes_termination`: no Gusto twin; `access_removed_after_last_day`: needs time and WorkOS deactivation | R8, R15, R16 |
| invoice-three-way-match | ed90f18 | 4 / 5 / 1 | Batch intake, invalid input, Slack | `bills_read_from_erp`, `clean_match_auto_approved`, `variance_needs_ap_approval`, `over_billed_held`, `duplicate_never_approved`; `entering_clerk_cannot_approve` 404 (nothing planned): every bill, PO and receipt is in NetSuite | R4 |
| change-management-gate | ed90f18 | 5 / 5 / 1 | Intake, freeze and author rules where no GitHub data is needed, faults | `change_facts_read`, `standard_change_deploys`, `normal_change_needs_cab`, `healthy_watch_marks_success`, `degraded_watch_rolls_back`: the GitHub twin has no pull request, check runs or deployments to read (`GET /repos/acme/checkout/pulls/1` → 404) and Datadog has no twin; `author_cannot_approve` 404 follows | R18, R21 |
| month-end-close | af7aa6f | 4 / 4 / 2 | Plaid sandbox link and transactions, Stripe auth fault, invalid input | `payouts_read`, `payouts_reconciled`: the Stripe twin's payout `arrival_date` isn't epoch seconds (the runtime threw; fixed afterwards in 43ddbe8, not yet re-proven); `accrual_reverses_next_period`, `fee_journal_on_approval`, `signoff_locks_period`: NetSuite; `reminder_while_open`: time | R4, R15, R20 |

_Wave 2 and 3 receipts (customer-data-sweep, lead-routing-sla, vulnerability-remediation, contract-intake, dsar-export, consent-propagation, crm-billing-sync, purchase-request-to-po, support-sla-breach, treasury-payment-approval, usage-true-up, customer-kyc-rescreen; then inventory-replenishment, delivery-exception, payroll-anomaly-review, visa-and-leave-expiry) are queued; rows are added as they land._

### Corrections found by the proofs (our bugs, not FetchSandbox's)

- month-end-close validated Plaid access tokens against the documented
  `access-<env>-<id>` shape; the twin's tokens look like `aaa_9a99a99999aa9999`.
  Plaid calls tokens opaque, so the runtime now accepts any non-blank token.
  The first receipt (ed90f18) failed every check at baseline for this reason.
- support-sla-breach (local tests, before any proof): overlapping sweeps both
  read "not tagged" and alerted twice. Fixed with a Zendesk `safe_update`
  compare-and-swap claim per step.

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
| R14 | **Missing twins named by earlier receipts:** restricted-party screening (Trade.gov CSL), Statuspage, Salesforce CPQ, Google Workspace Admin / SCIM, license-cost data; and faithful read-backs on Box search, Notion database query, Asana task listing, Calendar `events.get`, PagerDuty notes, Stripe credit notes, transfer reversals and invoice lines. | the saved receipts linked from each guide in `docs/workflows/` | each receipt's explanation | per twin |
| R15 | **Runtime clock control.** A contract step that advances the runtime's clock (e.g. the verifier calls a declared `POST /verify/clock {advance_ms}` on the app, or sends an `X-FetchSandbox-Now` header the runtime may honour on `tick`), recorded in the receipt like any other step. | every "(needs clock control)" check: dunning day 14/21, access-review deadlines, offboarding last day, month-end reminder, lead SLA, vulnerability SLA, contract chase/void, DSAR deadline, consent read-back, PO lapse, SLA breach, payment cut-off, true-up notice window, KYC SAR deadline, late receipts, delivery re-check, payroll deadline, visa/leave dates | the verifier has no time step; durable timers measured days out can only be proven locally | A check can say "advance 15 days, then tick" and observe the timer's effect in saved state |
| R16 | **Payroll twin (Gusto first).** Employees with terminations, regular and off-cycle payrolls with per-employee compensation, `version`-guarded updates, submit. | employee-offboarding final pay; payroll-anomaly-review | "Unknown providers: gusto" | A termination and its off-cycle payroll can be asserted on the twin |
| R17 | **Payment-operations twin (Modern Treasury).** Counterparties, external accounts with verification status, payment orders with Idempotency-Key, status transitions (approved → sent → completed / returned). | treasury-payment-approval | no twin | One payment order per idempotency key, and a seeded return observed a day later |
| R18 | **GitHub org, pull request, checks, deployments and Dependabot fixtures.** `GET /orgs/{org}/members`, membership delete; seeded pull requests with reviews and check runs; deployments with statuses; Dependabot alerts and their dismissal. | user-access-review GitHub leg; change-management-gate; vulnerability-remediation | `/orgs/acme/members` → "Unknown method"; `/repos/acme/checkout/pulls/1` → 404 | A contract can seed a PR with an approving review and passing checks and observe the deployment it causes |
| R19 | **E-signature twin (DocuSign).** Envelopes with a custom field, status changes, reminders, void. | contract-intake | "Unknown providers: docusign" | An envelope is created once per contract id and voided at 30 days |
| R20 | **Field fidelity and robustness on existing twins.** Stripe payout `arrival_date` as epoch seconds; Plaid tokens in Plaid's format; Stripe customer create under 8 concurrent requests without a non-JSON "upstream connect error". | month-end-close `payouts_read`; customer-data-sweep seeding | observed 2026-10-22 | Seeding 250 customers 8-wide succeeds and payout dates parse as Stripe documents them |
| R21 | **Observability twin (Datadog).** Monitors with states and metric queries a contract can script (healthy vs degraded after a deploy). | change-management-gate watch and rollback | "Unknown providers: datadog" | A degraded monitor after deploy makes the runtime roll back, observed on GitHub deployments |

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

