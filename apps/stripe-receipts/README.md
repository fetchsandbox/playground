# Stripe order and Resend receipt playground

Adapted from `apps/stripe` at commit 9d33904e78ef1148553eac17432eaf8b81fb39ba.
A verified payment event marks an order paid and requests a receipt through
Resend. This is a disposable QA fixture with in-memory state and no
authentication. Run it only on loopback, with one worker, using isolated
FetchSandbox twins or local provider fakes. It is not production ready.

Install and run with Python 3.12 or newer:

```sh
uv venv --python 3.12
uv pip install --python .venv/bin/python -r requirements-dev.txt

# Supply actual isolated FetchSandbox bindings or local fake server addresses.
export STRIPE_API_KEY='sk_test_fixture'
export STRIPE_WEBHOOK_SECRET='whsec_fixture'
export STRIPE_API_BASE='http://127.0.0.1:9081'
export RESEND_API_KEY='re_test_fixture'
export RESEND_API_BASE='http://127.0.0.1:9082'
export RESEND_FROM='receipts@example.test'
.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8080 --workers 1
```

The example provider ports require separately running fakes. Public Stripe and
Resend API URLs are rejected at startup. Permitted provider addresses are HTTP
loopback URLs without a path or HTTPS `fetchsandbox.com/sandbox/<id>` URLs.
Stripe keys must start with `sk_test_`; never supply production credentials.
Customer and sender addresses must use `@example.test`. No real payments or
customer email are authorized for this fixture.

The application validates positive integer quantities, order/payment identity,
amount, currency, signatures and test-mode events. Repeated payment creation
uses one intent. Webhook deduplication uses the event ID; receipts also use a
stable order/payment idempotency key. Receipt errors return 503 so redelivery
can retry. Late payment events preserve terminal order states. Refunds track
partial amounts and distinguish pending, successful and failed attempts;
uncertain provider responses retain their retry key. State changes and provider
calls are serialized in this single process.

The running-app tests exposed two FetchSandbox PaymentIntent contract gaps:
a form amount came back as a string, and the client secret was null. The staging
twin now returns an integer amount and a synthetic non-null secret. The app
keeps strict integer validation. The synthetic secret cannot confirm a card
with Stripe.js; this demo has no browser checkout.

Run supplementary regressions without any provider network access:

```sh
.venv/bin/python -m pytest tests/test_regressions.py -q --tb=short
```

These tests exercise the actual FastAPI routes and Stripe signature verifier
through TestClient. Provider methods are deterministic fakes, including lost
responses and concurrent requests. Original-code results are preserved in
[`qa_evidence/local-before.txt`](qa_evidence/local-before.txt) (25 failed,
5 passed) and [`qa_evidence/local-extra-before.txt`](qa_evidence/local-extra-before.txt)
(14 failed, 1 passed). New safety/review tests are excluded from those baseline
counts. [`qa_evidence/local-after.txt`](qa_evidence/local-after.txt) records the
latest saved post-fix suite run.

The final local run passed all **63 tests**. These are supplementary regression
results, not independent provider certification. The complete status and
coverage review are in [`qa_evidence/report.json`](qa_evidence/report.json).

For running-process checks against FetchSandbox twins, use
[`qa/twin_workflow.py`](qa/twin_workflow.py). It starts the real application,
forwards provider traffic only to the supplied twins, posts signed webhooks,
and records HTTP results plus forwarded calls. Bindings are private JSON with
`stripe` and `resend` objects, each containing `base_url` and `api_key`:

```sh
.venv/bin/python qa/twin_workflow.py \
  --bindings /private/path/fetchsandbox-bindings.json \
  --case two_orders_headerless \
  --run-id FETCHSANDBOX_RUN_ID \
  --output qa_evidence/twin-local-run.json
```

Supported cases are `baseline`, `two_orders_headerless`,
`duplicate_delivery_headers`, `repeated_pay` and `receipt_retry`. Receipt fault
behavior must be configured in the isolated twin. Captured forwarding logs
show requests made by the app; provider acceptance requires separate provider
evidence. Neither mocked regressions nor provider-only calls constitute an
independent FetchSandbox before/after proof.

FetchSandbox's [proof attempt](https://fetchsandbox.com/runs/fix-58aa10e9eae9?flow=1cd3195dcf26)
returned `unproven_unavailable`, `verified: false`: it could not execute the
real code independently and supplied no more specific execution diagnosis.
The raw result is saved in `qa_evidence/fetchsandbox-proof.json`.

The corrected app passed six running-process checks against fresh **staging**
twins: normal receipt, two distinct orders without a delivery-ID header,
duplicate event deliveries, repeated payment creation, receipt recovery after
an injected email error, and recovery after an accepted email response was
withheld. These are independent QA-driver results, not a completed persona or
an engine-issued before/after proof. See `qa_evidence/stage-summary.json`.

A focused response-loss rerun independently observed the stored email count
increase from 3 seeded records to 4 while the first response was still held.
The app returned 503 at its 12-second deadline, retried before the original
15-second response completed, and recorded one receipt. The provider count
remained 4. See `qa_evidence/stage-accepted-response-loss-independent-counts.json`.
All fresh test sandboxes were deleted and disposable MCP keys revoked.

The existing unprimed Claude persona discovered lost receipts and skipped
orders, but exceeded the turn deadline without a terminal result or engine
proof. Its outcome is **UNMEASURED**. Do not present the successful QA-driver
checks as a persona pass. The separate cross-service regression persona also
ended without a terminal result. Both keys were revoked.

Remaining limits: there is no authentication, authorization, database, durable
event ledger or background receipt outbox. Restarting loses all application
state. Multiple workers and crash recovery are unsupported. Browser checkout,
card confirmation, actual Stripe settlement and inbox delivery have not been
verified. Long-delay retry safety also needs durable reconciliation:
[Resend retains idempotency keys for 24 hours](https://resend.com/docs/dashboard/emails/idempotency-keys),
and [Stripe keys may be removed after at least 24 hours](https://docs.stripe.com/api/idempotent_requests).
No permanent exactly-once guarantee is claimed.
