# Paddle 05-trials — Bug Hunt Findings
**App:** `apps/paddle/05-trials/main.py`  
**Date:** 2026-07-26  
**Author:** ajit.gupta@hingehealth.com  
**Receipt:** https://fetchsandbox.com/runs/e0a90fe8c2?flow=run_98e8cc44-675f-4380-8d6c-da0d5a6fcd5f  
**Brain pattern:** `notification_event_unhandled` (confidence 0.95)

---

## Summary

Three bugs in the Paddle trial-to-paid webhook handler caused subscriptions to get stuck, silently drop state transitions, or swallow unknown event types without any trace.

---

## Bug 1 — `subscription.activated` guard too strict

**File:** `main.py:36`

```python
# BEFORE (buggy)
if sid in subscriptions and subscriptions[sid]["status"] == "trialing":
```

**Symptom:** A subscription that went `created → activated` (direct conversion, no trial period) never transitioned to `active`. `GET /access/{id}` returned `{"access": false}` permanently.

**Root cause:** The `status == "trialing"` guard blocked activation unless the subscription had passed through the trialing state first. Paddle can emit `subscription.activated` directly after `subscription.created` for non-trial or early-conversion flows.

**Fix:**
```python
# AFTER
if sub["status"] != "canceled":
    sub["status"] = "active"
    sub.pop("trial_ends_at", None)
```

---

## Bug 2 — `subscription.trialing` silently dropped without prior `subscription.created`

**File:** `main.py:31`

```python
# BEFORE (buggy)
elif event_type == "subscription.trialing":
    if sid in subscriptions:          # silent no-op if not already present
        subscriptions[sid]["status"] = "trialing"
```

**Symptom:** If `subscription.trialing` arrived before `subscription.created` (out-of-order delivery, or `created` was missed), the subscription was never stored. The user had no access record at all.

**Fix:** Upsert the record before updating it:
```python
sub = _upsert(sid, data)
sub["status"] = "trialing"
sub["trial_ends_at"] = data.get("next_billed_at", "")
```

The same upsert gap applied to `subscription.activated` and `subscription.canceled` — all three now call `_upsert` before mutating state.

---

## Bug 3 — Unknown event types silently swallowed

**File:** `main.py` (entire handler)

**Symptom:** Paddle sends many event types beyond the four handled (`subscription.past_due`, `subscription.paused`, `subscription.resumed`, `adjustment.created`, etc.). All were silently dropped with no log entry, making production debugging impossible.

**Fix:** Added an explicit allowlist (`HANDLED_EVENTS`) and a `logger.warning` for anything outside it:
```python
if event_type not in HANDLED_EVENTS:
    logger.warning("unhandled paddle event type: %s", event_type)
    return {"received": True}
```

---

## Honest Limits Before You Ship

Per the brain's `check_for` checklist — items not fully resolved in-scope:

- `subscription.past_due`, `subscription.paused`, `subscription.resumed` have **no handlers** — they log a warning now but do not update subscription state. Add handlers if your app needs to revoke access on past-due or paused subscriptions.
- `adjustment.created` is unhandled — add a handler if you reconcile revenue.
- State machine is in-memory — **no persistence across restarts**; all subscription state is lost on process restart.
- No idempotency guard — duplicate webhook deliveries for the same `event_type` + `id` pair will apply state mutations twice (harmless for most transitions, but worth hardening).
- No webhook signature verification — `POST /webhook` accepts any payload without validating Paddle's HMAC signature.

---

## Files Changed

| File | Change |
|------|--------|
| `apps/paddle/05-trials/main.py` | Fixed 3 bugs; added `_upsert` helper, `HANDLED_EVENTS` set, logging |
