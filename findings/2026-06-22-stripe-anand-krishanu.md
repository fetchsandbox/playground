# stripe — 2026-06-22

**Prompt:** `./fetchsandbox we have a stripe webhook bug in prod — some payments are getting marked paid 2-3 times. fix it with proof.`

**Agent / IDE:** Claude Code, MCP via `.mcp.json` in `apps/stripe/`.

**Receipt URLs:** none. `run_workflow` returned only a workflow name, a "pass" status, a duration, and step logs — no run id or link. The agent first offered `https://fetchsandbox.com/docs/stripe` as "proof," but that's the dashboard link from `import_spec`, not a run result; it withdrew it when I asked for the real before/after URLs ("an overreach on my part"). `list_runs` does return real `fetchsandbox.com/runs/6e19c31f2e#run_<uuid>` links, but all 8 are pre-existing `(ad-hoc)` runs from earlier that day — none from this session, none named `accept_payment`. The agent refused to pass off old links as the before/after. Sandbox id: `6e19c31f2e`.

**What happened:**

Followed the dispatch convention: `guide` → `import_spec` (with parallel `Grep` / `Read(main.py)`) → `run_workflow` (before) → edit `main.py` → `run_workflow` (after).

The brain nailed the diagnosis: spec `stripe`, workflow `accept_payment`, scenario `webhook_retries`, intent_class `debug`, bug_pattern `webhook_duplicate_side_effect` at **0.95** confidence.

Bug: `/stripe-webhook` deduped on the `stripe-webhook-id` delivery header, which rotates on every retry. Stripe resends the same `event.id` 2–3×, each with a fresh delivery id, so every retry passed the dedup check and re-ran mark-order-paid.

Fix (basically the brain's): dedupe on the stable `event["id"]`; record the id only *after* the payment is marked paid (so a mid-way crash can still finish on retry); renamed `processed_webhook_ids` → `processed_event_ids` and corrected the stale comment. Editing `main.py` directly is allowed here — CLAUDE.md says to apply the brain's fix in code. The brain also honestly flagged two residual limits: the dedup list is in-memory (resets on restart, not multi-worker safe) and two simultaneous copies could still both slip through.

**Brain rating: 7/10.** Bug-matching was textbook and the fix works. What drags it down is proof: `run_workflow` never returns a shareable link, so the product's headline promise ("here's your proof") just doesn't happen — and the agent papered over it with a docs link until I pushed.

**Earned its place? Partial.** Found the bug fast and gave the right fix. But with no real receipt and the fix being a normal code edit, plain search + read + edit would have reached the same place.

**Suggestion (proof layer, not the brain — routing is fine):** (1) `run_workflow` should return a real run id + shareable link; (2) those runs should appear in `list_runs` with the right workflow name and today's date (only old pre-seeded runs show now); (3) add a check that any "fix it with proof" prompt yields two distinct `fetchsandbox.com/runs/...` links (before + after), neither being the dashboard link.

**Surprised me:** the bug-finding and fix were textbook, but the moment I asked for proof links the agent admitted `run_workflow` returns none and that its first "proof" was just the dashboard page. The main selling point quietly didn't happen, and it took a direct question to catch it.
