# Stripe → Resend QA example

A customer creates an order. A signed payment-success event marks it paid and
sends one receipt. Payment creation and receipt retries retain their identity.

## Measured on October 9, 2026

- 63 local regression tests passed, using fake provider boundaries.
- Six actual running-app checks passed against fresh FetchSandbox staging twins:
  normal receipt, two distinct orders, duplicate events, repeated pay, email
  server-error recovery, and accepted-email response-loss recovery.
- In the response-loss check, the provider stored one email before releasing
  its delayed response. The app returned 503 at its 12-second deadline. A retry
  started before the 15-second response finished and recovered the same email.
  Provider storage grew by exactly one record.
- Disposable MCP credentials were revoked. Fresh staging sandboxes were deleted.

Inspect [the checks](qa_evidence/stage-summary.json),
[response-loss HTTP timeline](qa_evidence/stage-receipt_retry-accepted_response_loss.json),
[independent provider counts](qa_evidence/stage-accepted-response-loss-independent-counts.json),
and [the full scope report](qa_evidence/report.json).

## Persona outcome

The unchanged checkout-readiness persona used the existing multi-turn Claude
harness and MCP 0.7.11. It reproduced skipped orders and lost receipt recovery.
It did not finish before the harness deadline and produced no engine-issued
before/after proof. Its verdict is **UNMEASURED**, not passed. A separate
cross-service regression persona also did not finish. Both keys were revoked.

## Scope

This is a loopback, single-process QA app, not a hosted production storefront.
Success webhooks were signed and injected by QA. No real Stripe settlement,
Stripe.js checkout or inbox delivery was tested. State is in memory; restart
recovery, multiple workers, authentication and a durable outbox are unsupported.
The staging PaymentIntent secret is synthetic and cannot confirm a real card.

Use [the README](README.md) for setup and private test bindings. Do not use live
provider credentials. Original buggy code is preserved at commit 0a2028c.
