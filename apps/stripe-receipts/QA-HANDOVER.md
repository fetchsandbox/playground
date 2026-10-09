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

## Payment-completion follow-up

The earlier staging checks injected a synthetic success object. They did not
confirm the created PaymentIntent. The original twin's generic completion
handler incorrectly returned `requires_capture` for automatic confirmation
and left `amount_received` at zero.

The bounded Stripe adapter now supports the synchronous Visa test-card aliases
for automatic confirmation and full manual capture. Missing methods, capture
before authorization, unsupported methods and attempts to overwrite outcomes
are rejected without changing state. It does not implement 3DS, issuer behavior,
partial capture, real settlement or all payment-method types.

The same loopback integration assertion failed with the original generic
completion handler and passed with the adapter. Actual uvicorn app and twin
servers exchanged HTTP requests; the test delivered the twin-emitted payment
payload, then replayed the same signed event. Stored emails increased from
three seed records to four and remained four after replay.

Inspect [before](qa_evidence/linked-payment-before.json) and
[after](qa_evidence/linked-payment-after.json). Webhook transport/signing remains
QA-controlled; external hosted delivery and the autonomous MCP persona are not
proved by this check. This candidate is local, not deployed.

Run this check with the backend checkout's Python environment (it contains the
engine dependencies), from this app directory:

```sh
FETCHSANDBOX_ENGINE_ROOT=/absolute/path/to/sandbox/backend \
  /absolute/path/to/sandbox/backend/.venv/bin/python -m pytest \
  tests/test_twin_completion.py -q
```

The app's existing `.venv` still runs its ordinary regression suite. The linked
engine integration test is explicitly skipped unless an engine checkout is supplied.
