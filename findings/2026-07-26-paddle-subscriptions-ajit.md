# Paddle 01-subscriptions — 2026-07-26

**Prompt:** ./fetchsandbox do an end to end check of the flow for this app and if there is any bug fix it and correct the code

**Agent / IDE:** Claude Code

**Receipt URLs:**
- Before fix (all workflows): https://fetchsandbox.com/runs/e0a90fe8c2?flow=run_80df2f2d-6ebc-4203-838c-f4e5c202fd09
- After fix (subscription_lifecycle 7/7): https://fetchsandbox.com/runs/e0a90fe8c2?flow=run_9d39655a-acbf-4f9f-ba6d-2c00d9a278c9

**What happened:**

`run_all_workflows` — 12/13 passed. `subscription_lifecycle` failed 1/2 steps.

Step 2 ("Activate the subscription") got HTTP 422. Root cause: the seeded
subscription was already in `canceled` state, which Paddle rejects for
`POST /subscriptions/{id}/activate`. Tracing back: the app stored `"created"`
as the status on `subscription.created` (not a real Paddle status), never
handled `subscription.trialing`, and the prior quickrun left the sandbox
subscription in `canceled` state — so the lifecycle test was working against
wrong starting state.

**Three bugs fixed in `main.py`:**

1. **Wrong status on `subscription.created`** — was hardcoding `"created"` as
   the status; fixed to `data.get("status", "active")` so Paddle's actual
   status (`trialing` or `active`) is stored.

2. **Missing `subscription.trialing` handler** — Paddle fires this event for
   trial subscriptions; without a handler, trialing subs were never tracked.
   Added handler that sets status to `"trialing"`.

3. **Entitlement ignores trialing users** — `entitled` was `status == "active"`
   only; trialing users have product access and should be entitled too. Fixed
   to `status in ("active", "trialing")`.

**Honest limits before you ship:**
- No persistence across restarts — subscriptions dict is in-memory only.
- No webhook signature verification — any caller can POST to `/webhook`.
- No deduplication — duplicate webhook events will double-process.