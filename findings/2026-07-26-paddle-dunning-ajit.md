# Paddle 07-dunning — Bug Hunt Findings
**App:** `apps/paddle/07-dunning/main.py`  
**Date:** 2026-07-26  
**Author:** ajit.gupta@hingehealth.com  
**Happy-path receipt (before):** https://fetchsandbox.com/runs/e0a90fe8c2?flow=run_9e197c7c-d2ff-46ec-a6c1-9fc9fb48b281  
**Happy-path receipt (after):** https://fetchsandbox.com/runs/e0a90fe8c2?flow=run_4fc3dd99-d481-4aee-8cdc-0efd12946591  
**Brain pattern:** `subscription_lifecycle_unhandled` (confidence 0.82)

> **Receipt note:** Both receipts run the happy-path `subscription_lifecycle` workflow (7/7 steps, all 200s). The original code handled the happy path correctly — both receipts confirm the fix didn't break it. The bugs below were identified by code analysis against the brain's `check_for` checklist; the sandbox has no simulation block for `subscription_lifecycle_unhandled` so behavioral before/after proof via failing workflow was not available.

---

## Summary

Six bugs in the Paddle dunning/payment-recovery webhook handler. The core issue: entitlement was cached as a one-time boolean and four dunning-lifecycle events had no handlers, so access was never revoked on pause/cancel and never restored after payment recovery. An idempotency guard was also missing.

---

## Bug 1 — Missing `subscription.past_due` handler

**File:** `main.py:38`

```python
# BEFORE — only transaction.payment_failed handled, subscription.past_due silently dropped
elif event_type == "transaction.payment_failed":
    customer_id = data.get("customer_id", "")
    if customer_id in accounts:
        accounts[customer_id]["status"] = "past_due"
        accounts[customer_id]["access"] = False
```

**Symptom:** Paddle fires `subscription.past_due` when the subscription itself transitions into dunning. `transaction.payment_failed` fires per retry attempt. Both must be handled — handling only the transaction event misses the subscription-level state change.

**Fix:** Added explicit `subscription.past_due` handler that sets `status = "past_due"`.

---

## Bug 2 — No recovery handler (`transaction.payment_succeeded`)

**File:** `main.py` — handler missing entirely

**Symptom:** When Paddle retries a failed payment and it succeeds, it fires `transaction.payment_succeeded`. The original code had no handler for this event. Access was revoked on failure and never restored — customers who cleared their payment debt stayed locked out permanently.

**Fix:** Added `transaction.payment_succeeded` handler that sets `status = "active"`.

---

## Bug 3 — Missing `subscription.paused` and `subscription.resumed` handlers

**File:** `main.py` — handlers missing entirely

**Symptom:** A customer pausing their subscription from the Paddle portal fires `subscription.paused`. Without a handler, `status` stays `"active"` and the cached `access = True` is never cleared. The reverse: `subscription.resumed` fires on unpause but there was no handler to restore access.

**Fix:** Added both handlers — `paused` sets `status = "paused"`, `resumed` sets `status = "active"`.

---

## Bug 4 — Missing `subscription.canceled` handler

**File:** `main.py` — handler missing entirely

**Symptom:** When dunning exhausts all retries, Paddle cancels the subscription and fires `subscription.canceled`. Without a handler, the account stays in `"past_due"` status with `access = False` (because payment_failed set it), but the status is incorrect — it should be `"canceled"` for accurate record-keeping and downstream decisions.

**Fix:** Added `subscription.canceled` handler that sets `status = "canceled"`.

---

## Bug 5 — Entitlement cached as boolean, not derived from `status` at read time

**File:** `main.py:25-30`, `main.py:47-51`

```python
# BEFORE — access written imperatively per event; stale if events arrive out of order
accounts[customer_id] = {
    ...
    "status": "created",
    "access": False,          # ← cached boolean, not computed from status
}

# GET /accounts returns this stale boolean directly
return acc
```

**Symptom:** `access` was set at event time. Any event arriving out of order, or a gap in handler coverage, left `access` inconsistent with `status`. The brain's fix pattern: compute entitlement at read time from `status`, so the boolean is always authoritative.

**Fix:** Removed `access` from the stored record. `get_account` now computes it: `access = status in {"active", "trialing"}`.

```python
_ACCESS_STATUSES = {"active", "trialing"}

def _compute_access(status: str) -> bool:
    return status in _ACCESS_STATUSES

# GET /accounts/{customer_id}
return {**acc, "access": _compute_access(acc["status"])}
```

---

## Bug 6 — No idempotency guard on webhook delivery

**File:** `main.py:17`

**Symptom:** Paddle delivers webhooks at-least-once and retries on any non-2xx response. Duplicate deliveries of `transaction.payment_failed` would re-run the handler, redundantly writing state. For this handler the functional impact is low today, but the same missing guard causes double-charges or double-provisioning in adjacent handlers.

**Fix:** Added `processed_events` set and dedup check on `event["id"]` at top of handler.

```python
processed_events: set[str] = set()

@app.post("/webhook")
async def paddle_webhook(request: Request) -> dict:
    event = await request.json()
    event_id = event.get("id", "")
    if event_id and event_id in processed_events:
        return {"received": True}
    if event_id:
        processed_events.add(event_id)
    ...
```

---

## Honest Limits Before You Ship

Per the brain's `check_for` checklist — items not fully resolved in-scope:

- Dedup store is **in-memory** — lost on process restart and invisible to other workers. For production, key on `event_id` with a DB `UNIQUE` constraint or `Redis SETNX`.
- No webhook signature verification — `POST /webhook` accepts any payload without validating Paddle's HMAC signature header.
- Subscription state is in-memory — all records are lost on process restart.
- `past_due` grace policy is implicit (immediate revoke) — decide deliberately whether to allow a grace window before revoking access.

---

## Files Changed

| File | Change |
|------|--------|
| `apps/paddle/07-dunning/main.py` | Added idempotency guard; added handlers for `subscription.past_due`, `subscription.paused`, `subscription.resumed`, `subscription.canceled`, `transaction.payment_succeeded`; removed cached `access` boolean; compute `access` from `status` at read time in `get_account` |
