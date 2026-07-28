# checkout-pro — 2026-07-21

**Prompt:** `./fetchsandbox i am working on this project called checkout pro and its not working as expected, i feel there is a bug in the code. can you look into the code and fix it use fetchsandbox mcp as required`

**Agent / IDE:** Claude Code (Sonnet 4.6 1M), MCP via `.mcp.json` in `playground/` root.

**Receipt URL:**
- Bug (double-charge on duplicate webhook): https://fetchsandbox.com/runs/1d8b8c50e7?flow=run_474a5864-59d4-43a9-b8cd-45622d64259d

**What happened:**

Read `routes/webhook.js` and spotted the race condition immediately — `dedupe.has(key)` check and `dedupe.add(key)` mark were split around `await fulfillOrder(event)`. Two concurrent deliveries of the same Stripe webhook both pass the `has()` check before either reaches `add()`, resulting in double charges.

Called `guide` with the full symptom description — routed to `accept_payment` workflow and surfaced the `webhook_duplicate_side_effect` bug pattern (95% confidence). Ran `quickrun` with `webhook_retries` scenario to reproduce, then `verify_behavior` with `webhook_duplicate_side_effect` — before/after probe showed buggy handler returning 409 on the charge-count check (double-charged), fixed handler returning 200 (single charge).

The fix was a one-line change in `routes/webhook.js`: replaced the `has`/`add` pair with `dedupe.claim(key)`, which already existed in `lib/dedupe.js` but was unused. `claim()` checks and sets atomically in a single synchronous call before the `await`, so no concurrent request can slip through. The fixed handler still returns 200 on the duplicate delivery — intentionally, so Stripe stops retrying.

The guide's `check_for` list also flagged that the in-memory `Set` in `lib/dedupe.js` won't survive a process restart. Acceptable for the stress-test app; production would need Redis SETNX or a DB UNIQUE constraint on `event_id`.

Score: 9/10 — the `claim()` fix was clean and the sandbox proof was unambiguous. One point off because `guide` surfaces a single pattern; would be nicer if it also flagged the in-memory-set durability issue as a second pattern in the same call.
