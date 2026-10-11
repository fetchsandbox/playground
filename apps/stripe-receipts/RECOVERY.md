# Stripe and Resend recovery checks

This extends this existing demo app. It does not establish universal provider parity or production readiness.

Orders and processed Stripe event IDs now use SQLite (`ORDERS_DB_PATH`, default `orders.sqlite3`). Use a new database for each disposable validation attempt. Writers serialize across processes; WAL readers can inspect the last committed state while an email request is pending. This deliberately small demo holds a write transaction during the receipt send. It is not a high-throughput queue design.

Payment confirmation first saves the PaymentIntent ID. The webhook verifies the real Stripe signature and reads the current PaymentIntent before changing the order, checking its order identity, amount and currency. Older failure events cannot revert a successful payment. A fully refunded order remains terminal.

The paid state and pending receipt intent survive a failed send. Every attempt uses the same Resend `Idempotency-Key` (`receipt/<order id>`) and exact content. The receipt ID and processed event ID are committed together after acceptance. Resend documents a 24-hour key window; an ambiguous intent older than that is held for manual reconciliation, not silently resent.

- `POST /orders/{id}/reconcile` reads Stripe and repairs a missed payment callback or pending receipt.
- `GET /orders/{id}/payment-events` reads Stripe-recorded success and failure event identities for this PaymentIntent. It does not fabricate events.
- `DELETE /orders/{id}` archives the order from the active list and retains the ledger and deduplication history.
- The catalog accepts mug, hat and poster, quantities 1–100 as strict integers, and a bounded email format. No order is written for invalid input.

Run local regression checks:

```sh
python -m pytest -q test_recovery.py test_before_controls.py
```

These tests use controlled provider doubles and genuine Stripe-signature verification. `fixtures/before_messy_suite.py` preserves the pre-change app and demonstrates its race, lost-response duplicate, stale-state and input/persistence defects. The local tests are not a Cursor persona acceptance result or a hosted FetchSandbox receipt. Production twin checks and process-interruption proof must be recorded separately.

## Recorded production twin proof

The actual local app, reached through the published MCP managed relay, passed 20/20 checks on production backend `6fee0b8c`. Receipt: https://fetchsandbox.com/runs/2735359355?flow=vr_fa79c72673ba4b1aa35f137319384b60

`verification-contract.json` is the inspected contract for this app. Start a fresh disposable session, bind its temporary settings privately, and configure this contract through `validate_integration`. This is actual app/twin execution evidence, not an unchanged Cursor persona pass. The run used MCP 0.7.17 for tunnel/private secret installation; 0.7.18 preserves native restart checkpoint instructions for agents.

The native owner really killed the app process (SIGKILL), restarted it with the same SQLite file and temporary bindings, and recorded different OS process IDs. FetchSandbox independently read different `/verification/runtime` instance IDs, then replayed the same recorded Stripe event and read the unchanged receipt count. The runtime endpoint only reports process identity; it cannot restart the process. This measures restart after a completed payment; a crash inside every transaction boundary remains outside this receipt.

The run included three overlapping first deliveries of one real success event, a withheld payment recovered through reconciliation, a real earlier declined-payment event withheld and replayed after success, four Stripe and four Resend refusal/timeout faults, a genuinely accepted Resend response held until a matching retry, seven invalid input cases, an unsigned callback, and ledger-preserving archival. The archive contains 66 Stripe and 20 Resend requests; 16 accepted send responses resolve to 15 unique email effects because the uncertain-send retry reused its existing effect.

The discarded attempt's MCP key was independently rejected with 401 after revocation; only its owned twins were removed. The receipt remains available. These are bounded checks against FetchSandbox twins, not a universal production certification or live Stripe/Resend comparison.
