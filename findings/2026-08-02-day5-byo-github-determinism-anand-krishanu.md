# day 5 — bring-your-own + determinism + re-test — 2026-08-02

**Agent / IDE:** Claude Code (Opus 5), headless, cold session per run. Cursor not tested.

## Bring your own — a spec outside the shipped 5

I wrote a small Node/Express **GitHub issue mirror** with a planted dedup bug — keyed on `X-GitHub-Delivery`, which is unique *per delivery attempt* — and pointed a cold agent at it.

**Prompt:** `./fetchsandbox our github issue mirror is double-counting syncs when github retries a webhook delivery — investigate it, fix it, and prove the fix with a before and after.`

**It generalizes.** Routed to the `github` spec, found the bug at `server.js:8`, and quoted my own misleading comment back as the tell: *"the old comment stated its own undoing."* Fix was correct — key on stable event identity (`action:issue.number:issue.updated_at`) instead of which HTTP attempt it was.

**S2 — but zero receipts.** Routed at **0.6 confidence with `workflow: null`** — catalog match, no curated workflow. `verify_behavior` then timed out on **all four** attempts and the run ended with **no receipt URL at all**. The agent proved locally against real code instead, and said so plainly: *"I didn't fake a receipt around it — but the local harness proves the fix directly against your actual `server.js`."*

This is the same shape as the earlier surge gap: Tier-1 specs have curated workflows; everything else routes at ~0.6 with `workflow: null` and has nothing runnable. The catalog advertises 50+ specs — only the curated few can produce proof.

**Receipt URL:** none

## Determinism — identical prompt, same app, three cold runs

`paddle/billing`, byte-identical prompt each time:

| | run 1 | run 2 | run 3 |
|---|---|---|---|
| confidence | **0.95** | **0.4** | **0.4** |
| workflow | `transactions_completed` | `subscription_lifecycle` | `subscription_lifecycle` |
| bug_pattern_id | `notification_not_acknowledged` | `notification_duplicate_side_effect` | `webhook_duplicate_side_effect` |
| runtime | 232s | 288s | 495s |
| applied a fix? | yes | yes | **no** |
| found the real bug? | **yes** | **yes** | **yes** |

**S2 — the conclusion is stable; everything around it is not.** All three runs correctly identified the missing idempotency guard. But confidence swung 0.95 → 0.4, three *different* `bug_pattern_id`s were assigned to the same defect, runtime varied 2.1×, and one run stopped at diagnosis without applying a fix. Confidence cannot be used as a gate, and `bug_pattern_id` cannot be used as a stable key for dashboards or dedup.

Receipts:
- https://fetchsandbox.com/runs/edcbaee720?flow=run_fc8af192-a540-4222-aee7-0487b66b6ea7
- https://fetchsandbox.com/runs/edcbaee720?flow=run_37c82961-f8f2-4edb-8937-315dc34f8b3e

## Re-test of earlier breaks

- **stripe receipt 504s (day 2):** now returns 200 on 2 of 3 attempts. Intermittent, not dead.
- **concurrency degradation (day 4):** confirmed. Running the batch strictly sequentially eliminated the `guide` timeouts I saw with 3 parallel sessions.

## Scope note

The brief's cursor-vs-claude-code comparison was not run — Cursor was agreed out of scope, so there was no second agent. The determinism table above is the substitute, and it is labelled as such rather than presented as a cross-agent result.

**Proved before claiming?** BYO github **Y** (proved on real code, explicitly refused to fabricate a receipt) · determinism runs **Y** (all three; run 3 stopped at diagnosis and did not claim a fix).

**Confidence: 3/5** — generalization of detection is real. Generalization of *proof* is not: outside the curated specs there is no receipt.
