# Provider spec audit (2026-10-22)

The acme-ops provider clients must call each vendor exactly as the vendor
documents it. FetchSandbox twins are then measured against that real behaviour,
so every difference is a gap we can name. A client shaped to fit a twin would
hide those gaps, because the twin and the client would agree with each other
and not with the vendor.

This audit compared every client call in `acme-ops/src/providers/` with the
vendors' own API references. The review was independent: three reviewers got
the code, not our conclusions. They had no direct page access from this
sandbox, so each verdict rests on search extracts of official pages (URLs are
in the commit history and review notes). A call that couldn't be confirmed is
marked "unverifiable", not "matches". No live provider was called.

## Rules the code now follows

- **Vendor shapes only.** A response that breaks the vendor's published API
  (a wrong type, an unwrapped object, a missing documented field) raises
  `SpecDeviation` and the run fails closed. The client never adapts to it.
- **Defensive checks are logged.** Production-sound checks stay in place, for
  example re-applying a documented filter on the client. When one fires it logs
  `provider spec deviation`, so a twin that ignores a filter shows up as a gap.
- **Vendor auth everywhere.** Each vendor's documented scheme applies wherever
  the base URL points. A bearer token is sent only when
  `<PROVIDER>_AUTH_SCHEME=bearer` is set; the FetchSandbox relay runner sets it
  for twins. Required identifiers (Twilio account SID, Modern Treasury
  organization, Plaid client id and secret, Gusto company, DocuSign account)
  fail at startup when they are missing.
- **Pinned API versions.** These clients are written against specific vendor
  versions, so each is pinned and an account's default can't change response
  shapes underneath them:

  | Vendor | Pinned version |
  |---|---|
  | Stripe | `2024-12-18.acacia` |
  | Shopify | `2026-01` |
  | GitHub | `2022-11-28` |
  | Notion | `2022-06-28` |
  | Gusto | `2026-06-15` |
  | Square | `2025-01-23` |

- **Test fakes follow the docs too.** `test/fake-world.ts` had copied some
  wrong calls, so tests and clients agreed with each other but not with the
  vendors. It now implements the documented behaviour, for example removing
  Shopify's order-based fulfillment create and requiring a NetSuite `entity`
  reference by id.

## Findings and status

| Vendor · call | Finding (vendor doc) | Status |
|---|---|---|
| Stripe · all calls | No `Stripe-Version` was sent. On 2025-03-31.basil or later, `invoice.subscription`, `invoice.payment_intent` and line `price` moved, and invoice items take `pricing[price]` | **Fixed**: pinned to `2024-12-18.acacia`. Migrating to the current version is a separate task |
| GitHub · Dependabot alerts list | `page`, `first` and `last` were removed on 2025-10-14; paging is by cursor | **Fixed**: follows the `Link` header |
| Box · upload | Uploads go to `upload.box.com/api/2.0` | **Fixed** |
| Box · download, extracted text | Downloads return raw bytes via a 302. Extracted text is plain text at `url_template` on `dl.boxcloud.com` | **Fixed**: raw bodies, URL used as given (both were truncated to 500 characters before) |
| Trade.gov CSL · search | Authenticates with a `subscription-key` header | **Fixed** |
| PagerDuty · incidents list | Array filters repeat the key | **Fixed**: the HTTP kit repeats keys for array values |
| Twilio Verify · auth | HTTP Basic auth | **Fixed** (the code sent bearer) |
| Twilio, PagerDuty, EasyPost, Modern Treasury · auth | Vendor schemes were applied only when the base URL exactly equalled the default host | **Fixed** (see the auth rule above) |
| Plaid · auth | `client_id` and `secret` go in the body; no API key exists | **Fixed**: no Authorization header in production |
| Shopify · create fulfillment | The order-based create was removed in 2022-07; use fulfillment orders | **Fixed** |
| Shopify · default version | 2024-10 is outside the support window | **Fixed**: 2026-01 |
| Shopify · inventory levels | At most 50 ids per call; `available` is null when untracked | **Fixed**: batches of 50; untracked items left out |
| Shopify · auth | `X-Shopify-Access-Token` only | **Fixed**: no extra bearer header |
| NetSuite · SuiteQL status filters | Status filters need `BUILTIN.CF(status) = 'Type:X'` | **Fixed**: replenishment and supplier bills |
| NetSuite · sales order customer | References are by id or external id, not email; `currency.refName` isn't documented as input | **Fixed**: customer looked up by email, then referenced by id; currency left to the customer or vendor default |
| NetSuite · lookup by external id | List items carry only `id`; the documented lookup is `/{type}/eid:{externalId}` | **Fixed** |
| NetSuite · SuiteQL paging | Response has `hasMore`; `limit` and `offset` go in the URL | **Fixed** |
| Gusto · final payroll | Calculate before submit; submit is asynchronous | **Fixed**: calculate, wait for `calculated_at`, then submit; reported as submitted, not processed |
| Gusto · exclude employees | Prepare first, then update with the prepared `version`; at most 100 compensations per call | **Fixed** |
| Gusto · list payrolls, list employees | Payrolls default to processed regular only; both lists paginate | **Fixed** |
| Modern Treasury · list payment orders | Pages may be blank while `X-After-Cursor` remains | **Fixed**; `reversed` orders are no longer counted as live |
| Modern Treasury · `receiving_account_id` filter | Not confirmed in the docs | **Kept, guarded**: results are filtered on the client and a deviation is logged |
| OpenAI · chat completions | `max_tokens` is deprecated (incompatible with reasoning models) | **Fixed**: `max_completion_tokens` |
| Zendesk · Show User | The user is wrapped in `user` | **Fixed**: no longer accepts a bare user |
| Stripe · payout `arrival_date` | Epoch seconds | **Fixed**: no ISO fallback |
| HubSpot · Communication Preferences v3 | Matches, though v3 is now listed as legacy | Open: migrate to `communication-preferences/status/update-subscription` |
| Notion · `2022-06-28` | Works for single-source databases; multi-source databases need 2025-09-03 | Open: noted |
| DocuSign · remind | `resend_envelope=true` may need the recipients in the body | Open, unverifiable |
| Stripe · `cancelSubscription` | Parameters are sent as a form body on DELETE | Open, unverifiable |
| Pre-existing shared code (2026-10-17) | Asana `createTask` special-cases sample gid `"12345"`; Stripe types accept ISO timestamps and item `price` as a bare id | **Open, owner decision**: used by already-verified workflows |

Rows marked "unverifiable" in the reviews (most Zendesk, GitHub, Gmail,
Calendar, Slack, Box search and DocuSign calls) found no deviation but could
not be confirmed from a fetched page. They should be re-audited where the
vendor doc hosts are reachable.
