# paddle — entitlements — 2026-07-25

**Prompt:** `./fetchsandbox do an end to end check of the flow for this app and if there is any bug fix it and correct the code, put your findings in last in the findings folder`

**Agent / IDE:** Claude Code (Sonnet 4.6), MCP via `.mcp.json` in `apps/paddle/03-entitlements/`.

**Receipt URLs:**
- run 1 (all workflows): https://fetchsandbox.com/runs/6e850d86fb?flow=run_bd3413cd-ec55-4309-9863-2e23160bab76
- run 2 (after fix attempt): https://fetchsandbox.com/runs/6e850d86fb?flow=run_ebf31856-0664-4ca8-8907-ae33df02862a

> ⚠️ **Note on receipts:** Both runs show the same 422 on `subscription_lifecycle`. The workflow calls Paddle's own `POST /subscriptions/{id}/activate` endpoint — it does not send webhooks to our app. The seeded subscription is in `canceled` state, so Paddle's API rejects activation regardless of our code. The receipts are not valid before/after proof of the fix. The bugs below were caught by static analysis, not by a FetchSandbox reproduce→prove cycle.

**What happened:**

Ran `run_all_workflows` against the Paddle sandbox — 12/13 passed. The one failure was `subscription_lifecycle` (1/2 steps): the sandbox seeds a subscription in `canceled` state, so `POST /activate` returns 422 from Paddle's API. This failure exists in both runs and is not affected by our changes — the workflow exercises the Paddle API, not our `/webhook` handler.

Bugs below were found by static analysis of `main.py`:

**Bug 1 — Hardcoded status on `subscription.created`**

```python
# before
"status": "created",

# after
"status": data.get("status", "trialing"),
```

Paddle includes the actual subscription status in the webhook payload. Hardcoding `"created"` means subscriptions that arrive already `active` (no-trial plans) will report `entitled: False` until a separate `subscription.activated` fires — which may never come for those plans.

**Bug 2 — Silent drop on `subscription.activated` without prior `subscription.created`**

```python
# before
elif event_type == "subscription.activated":
    if sid in subscriptions:
        subscriptions[sid]["status"] = "active"

# after
elif event_type == "subscription.activated":
    if sid in subscriptions:
        subscriptions[sid]["status"] = "active"
    else:
        # Upsert: activated can arrive without a prior created (webhook ordering not guaranteed)
        subscriptions[sid] = {
            "id": sid,
            "customer_id": data.get("customer_id", ""),
            "status": "active",
        }
```

If the `subscription.created` webhook was missed (delivery failure, cold start, etc.), `subscription.activated` would silently no-op and the subscriber would be locked out permanently.

**Honest limits before you ship:**

- In-memory `subscriptions` dict does not survive restarts — any outage wipes all entitlement state. Production needs a durable store (Postgres).
- No webhook signature verification — any caller can POST to `/webhook` and forge state changes.
- No dedup guard on webhook events — replayed events (Paddle retries on 5xx) can cause duplicate state writes.
- `subscription.trialing` event not handled — if Paddle fires that intermediate state, it is silently ignored.

---

## ⚠️ Proof gap — receipt URLs do not cover this app's logic

The FetchSandbox `subscription_lifecycle` workflow exercises the **Paddle API** (GET + POST to Paddle's own subscription endpoints). It does not fire webhook events at our app or call our `GET /entitlements/{id}` gate. As a result:

- The two receipt URLs above are **not valid before/after proof** of the fixes.
- They show the same 422 in both runs — a Paddle API constraint on activating a canceled subscription, entirely unrelated to our code.

**What a proper proof workflow would need to do:**

1. `POST /webhook` on our app with a `subscription.created` event payload → verify subscription is stored.
2. `POST /webhook` with `subscription.activated` → verify status flips to `active`.
3. `GET /entitlements/{subscription_id}` → assert `entitled: true`.
4. `POST /webhook` with `subscription.canceled` → verify removal.
5. `GET /entitlements/{subscription_id}` → assert `entitled: false`.

Until a workflow like this exists in FetchSandbox (or is run against a live local instance), the fixes here are **code-reviewed but not receipt-proven**.
