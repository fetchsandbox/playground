# Paddle 06-pause-resume — Bug Hunt Findings
**App:** `apps/paddle/06-pause-resume/main.py`  
**Date:** 2026-07-26  
**Author:** ajit.gupta@hingehealth.com  
**Receipt:** https://fetchsandbox.com/runs/e0a90fe8c2?flow=run_88c83088-a3fc-49ef-8c45-d3ea8d76abcb  
**Brain pattern:** `notification_duplicate_side_effect` (confidence 0.95)

---

## Summary

One bug in the Paddle pause/resume webhook handler: no idempotency guard on `event_id`. Paddle delivers webhooks at-least-once and retries on any non-2xx response, so duplicate deliveries of `subscription.paused` or `subscription.resumed` re-apply status mutations on every retry.

---

## Bug 1 — No idempotency guard on webhook delivery

**File:** `main.py:17`

```python
# BEFORE (buggy) — no event_id dedup, every delivery mutates state
@app.post("/webhook")
async def paddle_webhook(request: Request) -> dict:
    event = await request.json()
    event_type = event.get("event_type", "")
    ...
```

**Symptom:** A duplicate `subscription.paused` delivery (Paddle retry on transient network error) re-runs the status update handler, clobbering `status_updated_at` and re-entrantly writing state. For pause/resume the functional impact is low today (idempotent write), but the same pattern causes double-charges or double-provisioning in adjacent handlers where side effects are not idempotent.

**Root cause:** Paddle guarantees at-least-once delivery — the same `event_id` can arrive more than once. The handler had no dedup check on the stable `event["id"]` field.

**Fix:**

```python
# AFTER — dedup on stable event_id before touching any state
processed_events: set[str] = set()

@app.post("/webhook")
async def paddle_webhook(request: Request) -> dict:
    event = await request.json()
    event_id = event.get("id", "")
    if event_id and event_id in processed_events:
        return {"received": True}
    if event_id:
        processed_events.add(event_id)

    event_type = event.get("event_type", "")
    ...
```

---

## Honest Limits Before You Ship

Per the brain's `check_for` checklist — items not fully resolved in-scope:

- Dedup store is **in-memory** — lost on process restart and invisible to other workers. For production, key on `event_id` with a DB `UNIQUE` constraint or `Redis SETNX`, and commit the dedup record in the same transaction as the side effect.
- No webhook signature verification — `POST /webhook` accepts any payload without validating Paddle's HMAC signature header.
- Subscription state is in-memory — all records are lost on process restart.
- `subscription.past_due` and `subscription.canceled` have no handlers — silent no-ops if Paddle sends them.

---

## Files Changed

| File | Change |
|------|--------|
| `apps/paddle/06-pause-resume/main.py` | Added `processed_events` set and idempotency guard on `event_id` at top of webhook handler |
