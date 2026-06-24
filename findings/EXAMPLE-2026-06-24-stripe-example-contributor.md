# stripe — 2026-06-24

> **EXAMPLE finding** — this file demonstrates the shape. It's NOT a real
> session. Replace with your own and rename to
> `findings/<date>-<app>-<your-github-username>.md`. Open a PR.

## Prompt you sent

> ./fetchsandbox we have a stripe webhook bug in prod — some payments are getting marked paid 2-3 times. fix it with proof.

## Agent / IDE

Claude Code (Opus 4.7), MCP via `.mcp.json` in `apps/stripe/`.

## Tool-call sequence

1. Loaded the FetchSandbox MCP tools.
2. Called `mcp__fetchsandbox__guide` first with the stripped ask as `intent`.
3. Called `mcp__fetchsandbox__import_spec` to get a Stripe sandbox.
4. Read `main.py` to find the webhook handler.
5. Called `mcp__fetchsandbox__run_workflow` (`accept_payment` / `webhook_retries`) to reproduce — got the "before" receipt.
6. Edited `main.py` to apply the fix.
7. Called `mcp__fetchsandbox__run_workflow` again to confirm — "after" receipt.

## What the brain returned (mcp__fetchsandbox__guide)

- spec: stripe
- workflow: accept_payment
- scenario: webhook_retries
- intent_class: debug
- bug_pattern matched: `webhook_duplicate_side_effect`
- confidence: 0.95

## Receipt URLs surfaced

- before: https://fetchsandbox.com/runs/<id>?flow=run_<uuid>
- after: https://fetchsandbox.com/runs/<id>?flow=run_<uuid>

## What the agent identified as the bug

> `/stripe-webhook` deduped on the `stripe-webhook-id` delivery header.
> That header rotates on every retry; Stripe resends the same event 2–3x.
> So each retry passed the dedup check and re-ran `mark_order_paid`.

In plain terms: the dedup key was the per-delivery header, not the stable
`event["id"]`. Every retry looked brand new and the order got marked paid
again.

## What the agent's fix was

- Dedupe on `event["id"]` instead of the delivery header.
- Use an atomic primitive — SQLite `UNIQUE` constraint on event_id with
  `BEGIN IMMEDIATE`, OR Redis `SETNX`, OR Postgres `UNIQUE` — so the
  dedup + side-effect live in the same transaction. The check-then-add
  pattern is not multi-worker safe.
- Rename `processed_webhook_ids` → `processed_event_ids`.

## Brain quality rating (1–10)

**8/10**

The match was clean (0.95 confidence on the right pattern), the scenario
reproduced the bug deterministically, and the `check_for` items flagged the
atomic-dedup requirement explicitly. One point off because the brain didn't
surface the receipt URL inline at first — I had to ask the agent to surface
it. (Note: this gap was closed in v3.X — the receipts now snapshot
durably and the share_url is propagated in the MCP response.)

## Did FetchSandbox earn its place in this session?

**Yes.** The brain matched the exact failure mode in one shot. Without it
the agent would likely have fixed the surface symptom (dedup on `event.id`)
without realizing the in-memory + non-atomic concerns the `check_for`
items raised. The receipts gave me something concrete to share when
reporting the fix.

## Specific suggestion for brain.yaml for this spec

Pattern is already good. Possible enhancement:

- id: `webhook_dedup_persistence_limits`
- symptoms:
  - "duplicate events after restart"
  - "idempotency lost after deployment"
  - "duplicate processing in multi-worker deployment"
- reproduce_with:
  - workflow: `accept_payment`
  - scenario: `webhook_retries_with_restart`  *(does not exist yet — would need a scenario that restarts the simulated handler mid-replay)*
- check_for items:
  - dedup store survives process restart
  - dedup store shared across workers
  - UNIQUE constraint on event id
  - concurrent deliveries cannot bypass dedup logic

## What surprised you

The brain didn't just hand back the fix — it flagged "the fix you're
about to apply is correct but not multi-worker safe, here's what to do."
That kind of "honest limit" callout is the thing I didn't expect.
