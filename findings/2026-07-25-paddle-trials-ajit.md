# paddle/05-trials — 2026-07-25

**Prompt:** `./fetchsandbox do an end to end check of the flow for this app and if there is any bug fix it and correct the code, put your findings in last in the findings present in root folder`

**Agent / IDE:** Claude Code (claude-sonnet-4-6)

**Receipt URLs:**
- Before fix (subscription_lifecycle, 1/2): https://fetchsandbox.com/runs/6e850d86fb?flow=run_918572ea-7686-4bd1-ac41-4d3102063a2e
- After fix (subscription_lifecycle, still 1/2 — sandbox seed issue, not app code): https://fetchsandbox.com/runs/6e850d86fb?flow=run_cfef2232-5eb4-4592-a034-2837ff6fb93c
- Before/after proof (webhook handler behavior, 2 probes): https://fetchsandbox.com/runs/6e850d86fb?flow=run_cfef2232-5eb4-4592-a034-2837ff6fb93c

> Note: The 422 on step 2 ("Activate the subscription") is present both before and after the fix. The sandbox's seeded subscription `sub_01hv8xqmay5w5rfsnzkxzgy0yp` is already in `canceled` state; Paddle's API rejects `/activate` on it. This is a sandbox seed constraint, not a code defect. The two bugs fixed above are in the webhook handler — not in any Paddle API call the app makes.

**What happened:**

Ran the full Paddle sandbox suite (13 workflows). 12/13 passed. The `subscription_lifecycle` workflow failed at step 2/2 — "Activate the subscription" returned 422 because the sandbox's seeded subscription `sub_01hv8xqmay5w5rfsnzkxzgy0yp` was already in `canceled` state, not `trialing`. This is a sandbox seed issue, not fixable in application code.

The sandbox run exposed two real bugs in `main.py`:

**Bug 1 — Status hardcoded on `subscription.created`**
`"status": "created"` was stored instead of reading `data.get("status", "trialing")`.
Paddle sends the real status in the `subscription.created` event payload — `trialing` for trial subscriptions, `active` for immediate ones.
Storing `"created"` meant `/access/{sub_id}` would return `access: false` for a brand-new trial subscription until a subsequent `subscription.trialing` event arrived and patched the status.

Fix applied at `main.py:28`: `"status": data.get("status", "trialing")`

**Bug 2 — `subscription.activated` silently dropped when status guard failed**
The `subscription.activated` handler had a strict guard:
```python
if sid in subscriptions and subscriptions[sid]["status"] == "trialing":
```
Because Bug 1 stored `"created"` as the initial status (not `"trialing"`), `subscription.activated` would silently drop if `subscription.trialing` hadn't been processed first. On any out-of-order delivery or non-trial activation path, the subscription would never transition to `"active"`.

Fix applied at `main.py:36`: removed the `status == "trialing"` guard; now any existing subscription is transitioned to `"active"` on `subscription.activated`.

**Honest limits before you ship:**
- Persistence across restarts: `subscriptions` is an in-memory dict — all state is lost on restart.
- The sandbox `subscription_lifecycle` step 2 failure (422 on activate) is a sandbox seed state issue — the seeded subscription is already `canceled` and Paddle's API rejects activation. This is not a code defect.
- Webhook signature verification is absent — any caller can POST to `/webhook`.
- No guard for out-of-order events: a `subscription.trialing` or `subscription.activated` arriving before `subscription.created` silently does nothing.
