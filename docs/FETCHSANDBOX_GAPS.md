# FetchSandbox gap report

What FetchSandbox could prove for the acme-ops workflows, what it could not,
and what FetchSandbox would need to build to close each gap. Every claim
points to a receipt check or a recorded probe. Probes and runs were made on
2026-10-22 with `fetchsandbox-mcp@0.7.30`; the twins change often, so re-probe
before relying on a "not supported" line.

## Current status overlay — October 27, 2026

This report preserves the **October 22 measurements**, not a live capability
catalog. Use the [fix and proof plan](FETCHSANDBOX_FIX_PLAN.md) for current status,
priorities, remaining acceptance and estimated delivery windows. Do not silently
replace the historical receipts or count an unmeasured check as a pass.

- **R3 partially addressed:** backend `51284f50` includes cursor/address fixes;
  the [October 27 customer sweep rerun](https://fetchsandbox.com/runs/0978965681?flow=vr_e3c8446a1e2b43628bd85ab307355788)
  passed its eight declared checks, including a 250-customer segment across three
  pages. Fixture retry/isolation changed; the eight business expectations did not.
  Search fidelity, 5,000-record seeding benchmark and native-agent acceptance remain open.
- **R26 partially addressed:** dashed and undashed Notion page IDs now identify
  the same stored page in focused tests. The original visa/leave workflow has not
  been rerun; other Notion response fidelity is not certified.
- **R20 remains open:** the related address-form correction does not prove payout
  epochs, Plaid token formats or the original eight-wide creation requirement.
- Owned-validation access control, JWT ownership and cold-parse responsiveness
  received bounded fixes. A separate persisted-sandbox reload gap is reproduced
  and unfixed; saved receipts and live sandbox reload are different durability scopes.
- The latest `p5_crossservice` native run against `51284f50` was **UNMEASURED**.
  It is not native acceptance, even though the deterministic sweep receipt passed.

Qualification corrections: R9's original requester `locale` payload is not a
vendor-conformance oracle. Zendesk documents `requester.locale_id` for a new
requester during ticket creation, and reuses an existing requester without updating
its profile. Qualify the user-update path independently against the
[official ticket documentation](https://developer.zendesk.com/documentation/ticketing/managing-tickets/creating-and-updating-tickets/)
and [Users API](https://developer.zendesk.com/api-reference/ticketing/users/users/).
R6's old API-version examples are historical reproduction inputs, not a claim that
those versions are supported today; select and record a currently supported vendor
version before implementing a compatibility fix.

## Document workflows (DocuSign, Box, Dropbox) — October 29, 2026

Probed with `fetchsandbox-mcp@0.7.30` before building the document workflows
(signed-agreement-filing, new-hire-paperwork, vendor-compliance-docs,
external-sharing-audit). Per-workflow results are in the table under
"Results".

| Provider | Class | Evidence (2026-10-29) |
|---|---|---|
| DocuSign | **TM** twin missing | `validate_integration(providers:["docusign","dropbox","box"])` → "Unknown providers: docusign, dropbox"; `list_specs` "docusign" → 0 |
| Dropbox | **TM** twin missing | same refusal; `list_specs` "dropbox" → 0 |
| Box · `GET /folders/{id}/items` | **TD** | Body is `{items:[{limit, offset, entries:[sample objects]}]}`, not Box's `{entries, total_count, limit, offset}`; entries are fixed samples (2012 dates, `"sample-value"` owners) and folders created in the session never appear |
| Box · `POST /folders` | **TD** | Returns `{name, parent, id}` with a UUID id (Box: numeric string, `type: "folder"`); the same name twice → 201 both times (Box: 409 `item_name_in_use`) |
| Box · `POST /files/content` | **TD** | `entries[0].id` is `obj_…` (R24), `name` is a generated `item-…` instead of the uploaded name, `parent` null |
| Box · `GET`/`PUT /files/{id}` for an uploaded file | **TD** | 404 "Resource obj_… not found", so a shared link can't be set or removed on a file the session created |

### Requirements added

| # | Requirement | Unblocks | Accept when |
|---|---|---|---|
| R27 | **DocuSign eSignature twin.** Envelopes from composite templates with roles, `notification` reminders/expiry, `include=recipients,custom_fields`, `form_data`, `documents/combined?certificate=true` (PDF bytes), list by `from_date`/`status`/`custom_field`, status changes a contract can drive (sent → completed / declined / voided), and Connect events (`envelope-completed`). | signed-agreement-filing, new-hire-paperwork, vendor-compliance-docs, contract-intake | A completed envelope's combined PDF is filed and asserted in the store twin |
| R28 | **Dropbox API v2 twin.** RPC on `/2/...` (files `get_metadata`, `create_folder_v2`, `list_folder` + `continue`; sharing `list_shared_links`, `modify_shared_link_settings`, `revoke_shared_link`) and content routes (`files/upload` with `Dropbox-API-Arg`, 409 `path/conflict`; `files/download` with `Dropbox-API-Result`). | every document workflow with `store.provider = dropbox`; external-sharing-audit | A file uploaded twice under one path conflicts the second time; a public link narrowed to team reads back `team_only` |
| R29 | **Stateful Box files, folders and shared links.** Folder items reflect what the session created (Box envelope, marker paging), `POST /folders` conflicts on a duplicate name, uploads keep their name and parent, and `PUT /files|folders/{id}` sets, changes and removes `shared_link` on session-created items. Extends R24. | every document workflow with `store.provider = box`; external-sharing-audit | A file uploaded into a created folder is listed in it, and its open link can be narrowed to `company` and read back |

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

## How a gap is classified

Every check that FetchSandbox could not prove is given exactly one cause,
with evidence. The clients are first audited against the vendors' own API
references ([PROVIDER_SPEC_AUDIT.md](PROVIDER_SPEC_AUDIT.md)), so a twin is
measured against the real API, never against our assumptions about it.

| Class | Meaning | Evidence that decides it |
|---|---|---|
| **Twin missing** | The provider isn't in the FetchSandbox catalog | `list_specs` or `validate_integration` → "Unknown providers" |
| **Twin spec divergence** | The twin answers a documented call differently from the vendor (shape, type, version, status) | Runtime log `SpecDeviation` or `provider spec deviation`, quoted against the vendor doc |
| **Operation not in twin** | The twin exists, but the documented operation is absent, returns 501 "not simulated", or returns samples instead of state | The twin's response, and the twin's published spec (endpoint count) |
| **Engine / verifier** | FetchSandbox lacks a capability the check needs | The capability, for example the clock during an attempt, webhook-to-check correlation, operator input, or tunnel allowance |
| **Our fixture or contract** | We didn't seed or declare something the twin supports | The contract or seed, fixed and re-run |
| **Our bug** | A runtime or contract error | Fixed, with commit |

## Results

Each row is one checked-in receipt (`acme-ops/verify/receipts/<workflow>.json`).
The app version is in the receipt, and every proof ran from a worktree pinned at
that commit. The 24 workflows built in this program were all re-proven after the
spec audit (4ac41d8 or later): **232 checks, 91 held, 96 violated, 45
unmeasured**. A violated or unmeasured check is listed with the one class that
explains it (see "How a gap is classified") and the evidence from the runtime
log or seed. Every listed check passes locally against the documented behaviour
(`acme-ops/test/`).

Legend: **TM** twin missing · **TD** twin spec divergence · **ON** operation not
in twin · **EV** engine/verifier · (consequence) means the check couldn't run
because an earlier step had no data.

| Workflow | Version | Held / violated / unmeasured | Not proved: class, evidence | Needs |
|---|---|---|---|---|
| failed-payment-dunning | 4ac41d8 | 5 / 3 / 2 | **ON** invoice `pay` → 501 "not simulated"; `auto_advance` and subscription invoices → 501; **TD** `finalize` → `paid`, `amount_due` 0 (invoice items not attached), so `attempt_count` is never observed; **EV** day-14/21 steps need the runtime clock | R2, R15 |
| customer-data-sweep | befeb35 | 4 / 4 / 0 | **TD** customer `address` isn't stored (create and GET both return `null`), so every customer is flagged; **TD** `has_more` false, so 100 of 275 customers are scanned (`full_scan_250`, `flag_limit_needs_approval`, `rerun_flags_nothing`) | R3, R20 |
| order-to-cash | befeb35 | 3 / 8 / 0 | **TD** Shopify twin has no supported Admin version: `POST`/`GET /admin/api/2026-01/orders…` → "No route matches"; it serves only 2020-01…2021-01; **TM** NetSuite, EasyPost | R4, R5, R6, R23 |
| supplier-bank-change | 93f319c | 4 / 5 / 4 | **TM** NetSuite (the vendor record), CSL screening, Twilio Verify; the four signal checks get 404 because nothing is planned without the vendor (consequence) | R4, R14 |
| user-access-review | 4ac41d8 | 8 / 4 / 0 | **ON** GitHub `GET /orgs/{org}/members` → "Unknown method" (`campaign_covers_every_system`, `github_member_revoked`); **EV** deadline and reminder need the runtime clock | R15, R18 |
| employee-offboarding | 4ac41d8 | 5 / 5 / 0 | **TM** Gusto (termination, final pay, deadline pay, rescission); **EV** + **ON** last-day removal needs the clock and WorkOS deactivation | R8, R15, R16 |
| invoice-three-way-match | 4ac41d8 | 4 / 5 / 1 | **TM** NetSuite: bills, POs and receipts all live there | R4 |
| change-management-gate | 06c2f09 | 5 / 5 / 1 | **ON** GitHub reviews (`GET …/pulls/4/reviews` → "Unknown method"), merge and deployments → 404; **TD** Datadog monitor id is a UUID string, while Datadog documents integers; **EV** watch window needs the clock | R15, R18, R21 |
| month-end-close | 4ac41d8 | 4 / 3 / 3 | **TD** Stripe payout `arrival_date` isn't epoch seconds (`SpecDeviation`); **TM** NetSuite journals and period lock; **EV** day-2 reminder | R4, R15, R20 |
| lead-routing-sla | befeb35 | 7 / 2 / 0 | **TD** HubSpot standard property `numberofemployees` → `PROPERTY_DOESNT_EXIST`, so the enterprise segment can't be seeded; **EV** SLA reassignment needs the clock | R15, R22 |
| vulnerability-remediation | befeb35 | 3 / 3 / 3 | **ON** GitHub Dependabot alerts → "Unknown method" | R18 |
| contract-intake | 06c2f09 | 2 / 0 / 8 | **TD** Box upload returns file id `obj_…`, while Box documents numeric ids, so the runtime rejects every seeded file; (behind it) **ON** OpenAI sample answers, **TM** DocuSign | R1, R19, R24 |
| dsar-export | 06c2f09 | 3 / 2 / 3 | **ON** Zendesk Search API → "Unknown method"; the identity and release signals get 404 (consequence); **EV** statutory deadline needs the clock | R9, R15 |
| consent-propagation | befeb35 | 4 / 4 / 1 | **ON** HubSpot Communication Preferences → "Unknown method"; **ON** CRM Properties API → "No route", so custom consent properties can't be defined and writes get 400 `VALIDATION_ERROR`. Stripe consent writes held | R22 |
| crm-billing-sync | befeb35 | 4 / 5 / 0 | **ON** HubSpot custom properties can't be defined (no Properties API), so every field write gets 400 | R22 |
| purchase-request-to-po | 06c2f09 | 2 / 4 / 4 | **TM** NetSuite (vendor, budget, POs) and CSL screening; approval signals 404 (consequence) | R4, R14 |
| support-sla-breach | 06c2f09 | 3 / 3 / 4 | **ON** Zendesk ticket list with cursor pagination (`page[size]`) → 501; **TD** ticket create with priority, status and tags → 422 "A subject and a supported ticket payload are required"; **EV** breach timers | R9, R15 |
| treasury-payment-approval | befeb35 | 2 / 4 / 4 | **TM** Modern Treasury and CSL screening | R14, R17 |
| usage-true-up | 06c2f09 | 5 / 4 / 1 | **ON** meter event summaries return 0 for every customer after the meter events were accepted with 200, minutes earlier (Stripe documents eventual consistency, so this needs a longer re-check); **TD** meter id is a UUID, not `mtr_…`; **EV** notice window | R15, R25 |
| customer-kyc-rescreen | befeb35 | 2 / 2 / 4 | **TM** CSL screening; Stripe Connect accounts were created fine | R14 |
| inventory-replenishment | 4ac41d8 | 3 / 6 / 0 | **TD** Shopify 2026-01 → "Unknown method" (orders, variants, products, locations); **TM** NetSuite | R4, R6 |
| delivery-exception | 06c2f09 | 4 / 5 / 0 | **TD** Shopify 2026-01 → "No route" (orders can't be created or read); **TM** EasyPost trackers | R5, R6 |
| payroll-anomaly-review | befeb35 | 3 / 4 / 1 | **TM** Gusto | R16 |
| visa-and-leave-expiry | befeb35 | 2 / 6 / 1 | **ON** Notion `POST /v1/pages` succeeds, but `GET /v1/pages/{id}` → 404 (no read-after-write) | R26 |

Earlier receipts, measured before the audit and not re-run, because they
belong to workflows already in review: ai-support-triage (3abd028: 18 / 3 / 0;
**ON** OpenAI sample answers, R1), cross-border-refund (78468f6: 26 / 0 / 4; R7,
R9, R10) and account-takeover-containment (40b5cbb: 20 / 0 / 2; R8).

### Tally by class (24 re-proven workflows)

| Class | Providers and operations |
|---|---|
| Twin missing | NetSuite (8 workflows), Gusto (2), EasyPost (2), Modern Treasury, DocuSign, CSL screening (4), Twilio Verify |
| Twin spec divergence | Shopify API versions (3 workflows), Stripe payout dates, Stripe customer address, Stripe pagination, Box file ids, Datadog monitor ids, Stripe meter ids, HubSpot standard property, Zendesk ticket create |
| Operation not in twin | GitHub orgs, reviews, merge, deployments, Dependabot; HubSpot Communication Preferences and Properties; Zendesk search and cursor pagination; Stripe invoice pay, auto-advance and meter summaries; Notion page read; OpenAI generation |
| Engine / verifier | Runtime clock during an attempt (15 workflows); tunnel allowance (every proof loop) |

### Our bugs the proofs exposed (fixed)

- Over-strict ID formats that the vendors don't guarantee: Plaid access token
  shape, Stripe meter id, EasyPost tracker id, and HubSpot contact ids capped at
  12 digits (HubSpot ids are 64-bit).
- Contracts whose baseline needed a provider. A missing twin then skipped every
  other check; baselines now only require a recorded run.
- Unseeded or wrongly seeded fixtures: a GitHub PR hard-coded as #1, an
  unuploaded Box file, Datadog credentials never passed to the app, and
  non-numeric placeholders that made baseline inputs invalid.
- A purchase-request contract that asserted an array (the verifier accepts
  only scalar values).
- support-sla-breach double alerts across overlapping sweeps, caught in local
  tests and fixed with a compare-and-swap claim.

## Requirements for FetchSandbox — original October 22 acceptance

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
| R15 | **Runtime clock control during an attempt.** FetchSandbox has an owner-only `/__fetchsandbox/fixtures/time` fixture step, but it is "unavailable during active attempts" and moves only twin time. A check needs a step that advances the *runtime's* clock mid-attempt (e.g. the verifier calls a declared `POST /verify/clock {advance_ms}` on the app, or sends an `X-FetchSandbox-Now` header the runtime may honour on `tick`), recorded in the receipt like any other step. | every "(needs clock control)" check: dunning day 14/21, access-review deadlines, offboarding last day, month-end reminder, lead SLA, vulnerability SLA, contract chase/void, DSAR deadline, consent read-back, PO lapse, SLA breach, payment cut-off, true-up notice window, KYC SAR deadline, late receipts, delivery re-check, payroll deadline, visa/leave dates | the verifier has no time step; durable timers measured days out can only be proven locally | A check can say "advance 15 days, then tick" and observe the timer's effect in saved state |
| R16 | **Payroll twin (Gusto first).** Employees with terminations, regular and off-cycle payrolls with per-employee compensation, `version`-guarded updates, submit. | employee-offboarding final pay; payroll-anomaly-review | "Unknown providers: gusto" | A termination and its off-cycle payroll can be asserted on the twin |
| R17 | **Payment-operations twin (Modern Treasury).** Counterparties, external accounts with verification status, payment orders with Idempotency-Key, status transitions (approved → sent → completed / returned). | treasury-payment-approval | no twin | One payment order per idempotency key, and a seeded return observed a day later |
| R18 | **GitHub twin beyond repos, pulls, issues and users.** The twin's spec has 15 endpoints. Missing operations: org members and memberships, reviews, check runs, deployments and statuses, and Dependabot alerts (list with cursor pagination, dismiss and reopen). | user-access-review GitHub leg; change-management-gate; vulnerability-remediation | `list_specs`: github 15 endpoints (repos, pulls, issues, users); `/orgs/acme/members` → "Unknown method". The 404 on `pulls/1` was our unseeded fixture, not a twin gap | A contract can seed a PR with an approving review and passing checks and observe the deployment it causes |
| R19 | **E-signature twin (DocuSign).** Envelopes with a custom field, status changes, reminders, void. | contract-intake | "Unknown providers: docusign" | An envelope is created once per contract id and voided at 30 days |
| R20 | **Field fidelity and robustness on existing twins.** Stripe payout `arrival_date` as epoch seconds; Plaid tokens in Plaid's format; Stripe customer create under 8 concurrent requests without a non-JSON "upstream connect error". | month-end-close `payouts_read`; customer-data-sweep seeding | observed 2026-10-22 | Seeding 250 customers 8-wide succeeds and payout dates parse as Stripe documents them |
| R21 | **Scriptable Datadog monitor and metric state.** A Datadog twin exists (235 endpoints). Whether a contract can make a monitor degrade after a deploy is being measured; the first receipt never gave the app Datadog credentials (our runner, fixed). | change-management-gate watch and rollback | Re-run at 4ac41d8 | A degraded monitor after deploy makes the runtime roll back, observed on GitHub deployments |
| R22 | **HubSpot beyond contacts.** The twin's spec has 13 endpoints (contacts only). Missing: the CRM Properties API (custom contact properties can't be defined, and standard ones such as `numberofemployees` are absent), Communication Preferences (subscription status, subscribe, unsubscribe), companies and deals. | consent-propagation, crm-billing-sync, lead-routing-sla | `list_specs`: hubspot 13 endpoints; `POST /crm/v3/properties/contacts` → "No route"; `numberofemployees` → `PROPERTY_DOESNT_EXIST` | Defined custom properties can be written and read back; the marketing subscription is turned off and read back |
| R23 | **Version-faithful twins.** Twins should honour the vendor's version header and serve supported versions: `Stripe-Version` (pinned clients), Shopify Admin versions inside the support window, `X-GitHub-Api-Version`, `Notion-Version`, `X-Gusto-API-Version`. | every pinned client | Shopify twin: 2020-01…2021-01 only; whether the Stripe twin honours `Stripe-Version` is being measured | A pinned client gets that version's shapes |
| R24 | **Box ids in Box's format.** Uploads return numeric file ids as Box documents them, and `/files/{id}` and the representations endpoints work for uploaded files. | contract-intake | upload → `obj_ccc36ef1…` | A file uploaded through `files/content` can be read and its text extracted |
| R25 | **Stripe usage billing.** Billing meters with `mtr_` ids, meter events aggregated into `event_summaries`, invoice items attached to draft invoices. | usage-true-up | events accepted, summaries 0 | 1,300 metered units for a customer read back as 1,300 |
| R26 | **Stateful Notion pages.** `POST /v1/pages` into a database, then `GET`/`PATCH /v1/pages/{id}` on the same page. | visa-and-leave-expiry | create 200, read 404 | A created register row can be read and updated |

## Engine and contract findings (not twin data)

- A check whose assertion is a single leaf (`repeat: 2`) is **driven twice**;
  a one-shot operator write (a full refund) then returns 400 on the second
  drive. Wrap such checks in `all_of` to drive them once.
- The first check must be plain HTTP (no signed event).
- Our own runner and contract mistakes found while classifying, all fixed:
  the relay runner had no Datadog mapping; employee-offboarding didn't
  declare GitHub; order-to-cash pinned Shopify to the twin's retired version;
  test fakes copied our wrong calls. Five older contracts
  (churn-risk-sweep, onboarding-kickoff, returns-warranty,
  revenue-reconciliation, support-escalation) still declare Zendesk as having
  no twin, though one exists now (left for the owner: existing workflows).
- Accepted blocked categories are `setup_missing` and `observation_missing`;
  `capability_missing` and `fixture_unsupported` are refused.
- `errorCode` can't be observed as a required field; provider-state filters
  fail when any record (including twin samples) lacks the field.
- Seeding happens before the run id exists, so fixtures can't be keyed to it.

