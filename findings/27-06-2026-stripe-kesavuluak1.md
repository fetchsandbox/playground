# stripe — 2026-06-27

**Prompt:** `./fetchsandbox we have a stripe webhook bug — payments getting marked paid 2-3 times. fix it with proof.`

**Agent / IDE:** Cursor (Composer), MCP via `.mcp.json` in `apps/stripe`.

**Receipt URLs:**
- after: https://fetchsandbox.com/runs/3522eb3790?flow=run_455de160-aaab-4505-bd4f-e048c34fb130
- before: none (fix was applied before the first workflow run completed)

**What happened:**

Brain matched `webhook_duplicate_side_effect` at 0.95 confidence via `/api/mcp/route`.
Picked `accept_payment` workflow + `webhook_retries` scenario.
Read `main.py`, found dedup was on the `stripe-webhook-id` delivery header
(rotates per retry) instead of `event["id"]`.
Fixed dedup to use `event["id"]`, re-ran `accept_payment` with scenario
`webhook_retries`, got the after-receipt (pass).

Brain felt useful — without it I'd have guessed at the wrong header or missed
the `check_for` callouts about in-memory dedup not surviving restart and not
being multi-worker safe. Score: 7/10 (one point off for no clean before-receipt
because the fix landed before the first repro run).
