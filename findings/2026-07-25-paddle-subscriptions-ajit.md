# paddle/01-subscriptions — 2026-07-25

**Prompt:** `./fetchsandbox do an end to end check of the flow for this app and if there is any bug fix it and correct the code, put your findings in last in the findings folder`

**Agent / IDE:** Claude Code (claude-sonnet-4-6)

**Receipt URLs:**
- Before fix (happy path, quickrun): https://fetchsandbox.com/runs/6e850d86fb?flow=run_b9e0736a-e4f9-4ac1-845c-2bd1372c363d
- Full workflow suite run: https://fetchsandbox.com/runs/6e850d86fb?flow=run_1b73fcd4-d2c2-40e1-8e31-ba52df468084
- After fix (re-run): https://fetchsandbox.com/runs/6e850d86fb?flow=run_3087b475-55c9-43e1-b9d8-497ba4db182e

**What happened:**

Ran the full Paddle sandbox suite (13 workflows). 12/13 passed. The failing workflow was `subscription_lifecycle` — step 2 "Activate the subscription" returned 422 because the sandbox's seeded subscription `sub_01hv8xqmay5w5rfsnzkxzgy0yp` was already in `canceled` state instead of `trialing`.

The sandbox failure exposed two real bugs in `main.py`:

**Bug 1 — Wrong initial status on `subscription.created`**
The handler hardcoded `"status": "created"` instead of reading `data.get("status", "active")`. Paddle sends the real status (`trialing` or `active`) in the event payload. A trial subscription would arrive with `status: "trialing"` but the app was storing `"created"` — a status that doesn't exist in Paddle's state machine. This also means `GET /subscriptions/{id}` would return a misleading status before activation.

Fix: `"status": data.get("status", "active")`

**Bug 2 — Entitlement excludes trialing users**
`entitled = sub["status"] == "active"` returned `False` for `trialing` subscriptions, denying access during the trial period. Trial users should have full service access.

Fix: `entitled = sub["status"] in ("active", "trialing")`

**Honest limits before you ship:**
- Persistence across restarts: `subscriptions` is an in-memory dict — all state is lost on restart.
- The sandbox `subscription_lifecycle` workflow still reports a step failure because the seeded subscription is already `canceled` in the sandbox's state (Paddle returns 422 for activating a canceled subscription). This is a sandbox seed issue, not a code issue — the fix cannot be validated via that specific workflow step.
- Webhook signature verification is absent — any caller can POST to `/webhook`.
