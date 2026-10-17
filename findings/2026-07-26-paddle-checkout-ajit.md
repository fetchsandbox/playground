# paddle checkout (08-checkout) — 2026-07-26

**Prompt:** `./fetchsandbox do an end to end check of the flow for this app and if there is any bug fix it and correct the code`

**Agent / IDE:** Claude Code (Sonnet 4.6, 1M), FetchSandbox MCP

**Receipt URLs:**
- before (subscription_lifecycle): https://fetchsandbox.com/runs/e0a90fe8c2?flow=run_0e69ba62-454a-4721-b880-51e6f1a28319
- before (transactions_completed): https://fetchsandbox.com/runs/e0a90fe8c2?flow=run_bdd1d043-f10c-47ff-a195-6c45cc474d85
- after (subscription_lifecycle): https://fetchsandbox.com/runs/e0a90fe8c2?flow=run_904cdcf8-57c6-424b-acec-bf3bdc37b8c2
- after (transactions_completed): https://fetchsandbox.com/runs/e0a90fe8c2?flow=run_76659a60-6409-46ba-b2ab-7a958e3d92d5

**Bugs found: 2**

---

### Bug 1 — No idempotency guard (duplicate webhook provisioning)

**File:** `apps/paddle/08-checkout/main.py`

Every other app in this repo (`06-pause-resume`, `07-dunning`, etc.) guards
against Paddle webhook retries with a `processed_events: set[str]` checked
against `event.get("id")`. `08-checkout` was missing this entirely. A Paddle
retry (which Paddle delivers up to 5x on non-2xx or timeout) would provision
extra seats into the workspace each time.

**Fix:** Added `processed_events` set and idempotency check at the top of the
webhook handler, consistent with the pattern used across other apps.

```python
processed_events: set[str] = set()

# in handler:
event_id = event.get("id", "")
if event_id and event_id in processed_events:
    return {"received": True}
if event_id:
    processed_events.add(event_id)
```

---

### Bug 2 — Double provisioning on subscription checkout

**File:** `apps/paddle/08-checkout/main.py`

When a user completes a checkout that creates a subscription, Paddle fires
**two** webhooks in sequence: `transaction.completed` (the checkout payment)
and `subscription.created` (the new subscription). The handler was listening
to both and calling `_provision_seats` for each — resulting in seats being
doubled for every new subscription checkout.

The canonical provisioning event for subscriptions is `subscription.created`.
The `transaction.completed` event should only provision seats for **one-time**
(non-subscription) purchases. The distinguishing field is `data.subscription_id`:
it is set on the transaction if the transaction belongs to a subscription.

**Fix:** Early-return from `transaction.completed` when `data.subscription_id`
is present, deferring to `subscription.created` to handle provisioning.

```python
if event_type == "transaction.completed":
    if data.get("subscription_id"):
        return {"received": True}
    # ... provision seats for one-time purchases only
```

---

**Honest limits before you ship:**

- `processed_events` is in-memory — it does not survive a restart and is not
  safe under multiple worker processes. A persistent store (Redis, DB) is
  needed for production dedup.
- No webhook signature verification (`Paddle-Signature` header). Any caller
  can POST arbitrary payloads.
- `subscription.updated` is not handled — seat count changes on plan upgrade
  or quantity change are silently ignored.
