# Paddle 02-billing — 2026-07-26

**Prompt:** ./fetchsandbox do an end to end check of the flow for this app and if there is any bug fix it and correct the code, put your findings in last in the findings present in root folder

**Agent / IDE:** Claude Code

**Receipt URLs:**
- Before fix (transactions_completed happy path): https://fetchsandbox.com/runs/e0a90fe8c2?flow=run_0cd9d2b8-327f-432a-a6cd-034a94330a24
- After fix (transactions_completed 5/5): https://fetchsandbox.com/runs/e0a90fe8c2?flow=run_b091f18e-0c28-4527-beb3-bd6c3da17c41

**What happened:**

Happy path passed. Brain matched `duplicate_provisioning_on_webhook_retry` via the memory graph.

Root cause: the `POST /webhook` handler in `main.py` had no idempotency check on `event_id`. Paddle retries any webhook that doesn't return 200 within ~5s, so the same `transaction.completed` event could be delivered more than once — each delivery added credits, double (or triple) charging the account.

**One bug fixed in `main.py`:**

1. **No idempotency guard on `transaction.completed`** — the handler applied credits on every delivery with no deduplication. Fixed by adding a `processed_events: set[str]` store; the handler checks `event_id` before any side effect and marks it processed after. A retry is acknowledged (200) but is a no-op.

**Honest limits before you ship:**
- No persistence across restarts — `processed_events` is in-memory; a restart clears it and a retried event could re-credit.
- No webhook signature verification — any caller can POST to `/webhook`.
- `event_id` guard is only applied when `event_id` is present in the payload; malformed events with no `event_id` bypass dedup.
