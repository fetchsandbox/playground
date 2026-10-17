# Acme public demo shop

A public fictional industrial product catalog with email-verified private orders. Stripe-hosted **test-only** checkout creates a real test payment. Payment state, amount, currency, customer and SKU must match provider readback before merchant evidence or CRM purchase records are created.

The existing refund workflow's versioned S3 catalog is authoritative. An operator script synchronizes its four products and immutable prices into Stripe, retaining the same SKU/policy mapping. Purchase and refund totals are copied into a dedicated HubSpot demo deal associated with the customer. Existing real contact properties are not overwritten. Native HubSpot products and line items are **blocked by the existing credential (403)**, not counted as synchronized. Existing unrelated workflows are not silently migrated to new product contracts.

Hardware begins with no received/inspected return. Software begins with no usage evidence. A labelled demo simulator can explicitly create synthetic merchant evidence; completed services remain non-refundable. The shop calls the existing six-role refund runtime, retaining its thresholds and Slack manager approval. Actual Stripe refund state is reconciled into CRM and the shop. A purchase email and refund outcomes go only to the verified customer. The prior workflow owns refund decision/outcome emails; the shop does not duplicate them.

## Durability and access

Orders, provider references, idempotency identities, email uncertainty and sessions are in DynamoDB, not process memory. Order updates use conditional leases. A lost checkout response is retried using the same Stripe idempotency key. A lost CRM creation response is resolved through provider search before another write. Accepted-but-lost email responses stay uncertain instead of blindly resending. Stripe webhook signatures and settled-payment readback drive fulfillment; an independently scheduled minute reconciliation uses the same path. No browser redirect asserts success.

Public orders require a one-use emailed code, expire in eight hours, and use Secure/HttpOnly/SameSite cookies. Cross-customer access returns 404. Mutations require a same-origin JSON header. Daily email/checkout/refund limits and API Gateway throttling bound public demo use. No provider credentials are exposed in the browser. No raw card data enters this app. Stripe test cards are entered on hosted checkout.

DynamoDB records have 30-day TTL (asynchronous expiry), PITR and retained table. Operational logs and failed-delivery queue retain 14 days. Existing versioned S3 merchant evidence retains prior versions under the refund deployment's current retention policy; this is not a 30-day deletion guarantee.

## Local checks

From this directory: `python -m pytest -q tests` (requires pytest, boto3 and httpx). Tests use explicit fakes and do not establish native provider acceptance. Deploy evidence is recorded separately.

## Deploy

Run `scripts/sync_catalog.py --refund-outputs <private refund stack outputs>` with the configured `fetchsandbox` AWS profile. Then deploy `AcmeDemoShop` using `acme-ops/infra/shop-app.ts` and contexts `policyBucket`, `providerSecretArn`, `refundRuntimeArn`, and `sourceCommit`. It creates a separate Lambda/API Gateway shop; it does not redeploy or alter the existing refund runtime. Register Stripe TEST checkout webhook events to the resulting `/api/stripe/webhook` and store the returned signing secret privately in the shop's Auth secret. Never commit outputs, session cookies, OTPs or secrets.

## Deployment checkpoint — 2026-10-17

Public URL: https://shop.fetchsandbox.com. Application version `acme-shop-1.0.3`, source `4a66a27`; existing refund runtime remains `acme-refund-1.0.4`. The public catalog has four products with descriptions/features, while customer signup asks only for email. The native Stripe TEST checkout webhook is registered.

Measured separately: 32 local shop tests and 62 existing refund tests passed. All four Stripe products/prices matched the shared catalog by independent provider readback. Public HTTP access checks rejected unauthenticated/forged sessions, cross-origin mutations and unsigned webhooks. A native DynamoDB component check rejected a second lease and stale writer and retained state across a fresh store instance. Email-code sign-in was observed in Chrome; its session survived a deployment update.

**One native acceptance case passed:** after unlocking the Mac, a Gateway purchase through actual Chrome Stripe TEST checkout settled for $1,000. The shop created the purchase evidence, HubSpot contact/deal association and purchase email. An explicitly simulated inspected return allowed a 20% request; the matching Slack approval produced one successful $200 test refund. The shop automatically showed completion, HubSpot recorded $200 refunded/$800 net, and Gmail API readback confirmed the customer outcome email. The Stripe processing screen did not visibly redirect; the saved shop order was opened manually after independent payment readback. This checkout used the raw API hostname; custom-domain HTTP/catalog checks were separate. Other products, automatic refunds, above-70% declines, advanced accepted-response-loss, process death, public load/abuse and all legacy workflow integration tests remain unmeasured in this native session. Native HubSpot product/line-item access remains blocked by 403 permissions; contact/deal purchase/refund synchronization passed for this order. Provider records follow the provider account’s retention; application TTL does not delete Stripe, HubSpot or Gmail records.
