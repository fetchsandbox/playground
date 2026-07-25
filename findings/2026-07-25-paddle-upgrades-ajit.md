# paddle/04-upgrades — 2026-07-25

**Prompt:** `./fetchsandbox do an end to end check of the flow for this app and if there is any bug fix it and correct the code, put your findings in last in the findings folder present in root`

**Agent / IDE:** Claude Code (claude-sonnet-4-6)

**Receipt URLs:**
- Before fix (subscription_lifecycle): https://fetchsandbox.com/runs/6e850d86fb?flow=run_b0683270-d5a4-4f7a-a970-e0b914f81f4b
- Full workflow suite (4 transaction workflows, all pass): https://fetchsandbox.com/runs/6e850d86fb?flow=run_9a78d554-5ca5-496d-94c3-b3e84e31cee4
- Before/after proof (real app behavior, 2 probes): https://fetchsandbox.com/runs/6e850d86fb?flow=run_06e47990-375d-423f-bec1-e727e5519db9

**What happened:**

Ran the full Paddle sandbox suite. 4/4 transaction workflows passed. The `subscription_lifecycle` workflow failed at step 2/2 — "Activate the subscription" returned 422 because the sandbox's seeded subscription `sub_01hv8xqmay5w5rfsnzkxzgy0yp` was already in `canceled` state, not `trialing`. This is a sandbox seed issue, not fixable in application code.

The sandbox run exposed two real bugs in `main.py`:

**Bug 1 — Status hardcoded on `subscription.created`**
`"status": "created"` was stored instead of reading `data.get("status", "active")`.
Paddle sends the real status in the event payload (`trialing` for trial subscriptions, `active` for immediate ones).
`GET /subscriptions/{id}` would return `"created"` — a status that doesn't exist in Paddle's state machine — until a subsequent `subscription.activated` event arrived.

Fix applied at `main.py:27`: `"status": data.get("status", "active")`

**Bug 2 — Status silently dropped on `subscription.updated` (upgrade path)**
The `subscription.updated` handler updated `plan_id` when an upgrade webhook arrived but never read or persisted the new `status` from the payload.
Plan upgrades (e.g. Basic → Pro) in Paddle always emit `subscription.updated` with the new status in `data.status`.
The app would return the stale pre-upgrade status on `GET /subscriptions/{id}` indefinitely — the defining bug of an upgrades app.

Fix applied at `main.py:45`: `subscriptions[sid]["status"] = data.get("status", subscriptions[sid]["status"])`

**Honest limits before you ship:**
- Persistence across restarts: `subscriptions` is an in-memory dict — all state is lost on restart.
- The sandbox `subscription_lifecycle` step 2 failure (422 on activate) is a sandbox seed state issue and persists after the fix — the seeded subscription is already `canceled` and cannot be reactivated. This is not a code defect.
- Webhook signature verification is absent — any caller can POST to `/webhook`.
- No guard for out-of-order events: a `subscription.updated` arriving before `subscription.created` silently does nothing.
