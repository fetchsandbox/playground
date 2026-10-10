# Stripe workflow boundary examples

Twenty small runnable applications, one for each named Stripe workflow guide
listed on FetchSandbox on October 10, 2026. Each contains a deliberately wrong
business decision and a candidate patch. The application stores records in
SQLite and exposes real HTTP create, sync, and read routes.

These are **bounded consumer-state examples**, not complete implementations of
every endpoint or browser flow in those guides. A generated probe executes the
application before and after the patch. Its receipt says which assertions and
requests were recorded, and whether its provider was a twin or a recording
double. A pass applies to that recorded rule, not every production invariant.

## Try one

1. Open one example directory in your editor and install `requirements.txt` in
   a virtual environment. Keep the original buggy `main.py` intact.
2. Connect the FetchSandbox MCP using the example's credential-free `.mcp.json`
   or the setup at https://fetchsandbox.com/mcp. Use your normal private login.
   Do not paste an account key into the application or an agent chat.
3. Describe the symptom from that example's README. Ask the agent to investigate
   the actual source, propose a fix, and obtain an application proof before
   applying it. `candidate.diff` is a reference, not a self-reported pass.
4. Inspect the receipt's original and candidate requests, persisted state,
   assertions, and dependency modes. An HTTP 200 alone is not a business pass.

The provider URL defaults to an unreachable loopback address. Each example
refuses live Stripe hosts. It can use an isolated FetchSandbox twin binding or
an explicitly declared loopback recorder. No live payments or messages are
needed. A generated recorder does not prove the real provider's full contract.

| Guide | Example |
|---|---|
| [Accept a Payment with PaymentIntents](https://fetchsandbox.com/docs/stripe?page=workflow-accept-payment-with-payment-intent) | [accept-payment-with-payment-intent](accept-payment-with-payment-intent/README.md) |
| [Accept Payment via Checkout Session](https://fetchsandbox.com/docs/stripe?page=workflow-checkout-session-payment) | [checkout-session-payment](checkout-session-payment/README.md) |
| [Create and Manage a Recurring Subscription](https://fetchsandbox.com/docs/stripe?page=workflow-create-subscription) | [create-subscription](create-subscription/README.md) |
| [Refund a Payment](https://fetchsandbox.com/docs/stripe?page=workflow-issue-refund) | [issue-refund](issue-refund/README.md) |
| [Save a Payment Method for Future Use (SetupIntent)](https://fetchsandbox.com/docs/stripe?page=workflow-save-payment-method-for-reuse) | [save-payment-method-for-reuse](save-payment-method-for-reuse/README.md) |
| [Create and Send an Invoice](https://fetchsandbox.com/docs/stripe?page=workflow-create-invoice-and-collect) | [create-invoice-and-collect](create-invoice-and-collect/README.md) |
| [Onboard a Connected Account (Stripe Connect)](https://fetchsandbox.com/docs/stripe?page=workflow-connect-onboard-account) | [connect-onboard-account](connect-onboard-account/README.md) |
| [Transfer Funds to Connected Account and Payout](https://fetchsandbox.com/docs/stripe?page=workflow-connect-transfer-payout) | [connect-transfer-payout](connect-transfer-payout/README.md) |
| [Handle a Payment Dispute (Chargeback)](https://fetchsandbox.com/docs/stripe?page=workflow-manage-disputes) | [manage-disputes](manage-disputes/README.md) |
| [Set Up Product Catalog with Prices](https://fetchsandbox.com/docs/stripe?page=workflow-product-catalog-management) | [product-catalog-management](product-catalog-management/README.md) |
| [Create a No-Code Payment Link](https://fetchsandbox.com/docs/stripe?page=workflow-payment-link-no-code) | [payment-link-no-code](payment-link-no-code/README.md) |
| [Set Up Webhook Endpoints for Event Handling](https://fetchsandbox.com/docs/stripe?page=workflow-webhook-endpoint-setup) | [webhook-endpoint-setup](webhook-endpoint-setup/README.md) |
| [Create Coupons and Promotion Codes](https://fetchsandbox.com/docs/stripe?page=workflow-coupon-promotion-code) | [coupon-promotion-code](coupon-promotion-code/README.md) |
| [Schedule Subscription Changes](https://fetchsandbox.com/docs/stripe?page=workflow-subscription-schedule-management) | [subscription-schedule-management](subscription-schedule-management/README.md) |
| [Issue Virtual Cards (Stripe Issuing)](https://fetchsandbox.com/docs/stripe?page=workflow-issuing-card-management) | [issuing-card-management](issuing-card-management/README.md) |
| [Verify Customer Identity (Stripe Identity)](https://fetchsandbox.com/docs/stripe?page=workflow-identity-verification) | [identity-verification](identity-verification/README.md) |
| [Accept In-Person Payment (Stripe Terminal)](https://fetchsandbox.com/docs/stripe?page=workflow-terminal-in-person-payment) | [terminal-in-person-payment](terminal-in-person-payment/README.md) |
| [Set Up Treasury Financial Account](https://fetchsandbox.com/docs/stripe?page=workflow-treasury-financial-account) | [treasury-financial-account](treasury-financial-account/README.md) |
| [Customer Self-Service Billing Portal](https://fetchsandbox.com/docs/stripe?page=workflow-billing-portal-customer-self-service) | [billing-portal-customer-self-service](billing-portal-customer-self-service/README.md) |
| [Create a Quote and Convert to Subscription](https://fetchsandbox.com/docs/stripe?page=workflow-quote-to-subscription) | [quote-to-subscription](quote-to-subscription/README.md) |

Recorded results: [coverage report](../../evidence/stripe-workflows-20261010/README.md).
