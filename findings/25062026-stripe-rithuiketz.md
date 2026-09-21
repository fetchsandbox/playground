# Stripe Webhook Duplicate Payment — Session Findings

**Date:** 25 June 2026  
**Author:** rithuiketz  
**Project:** Acme Orders (`apps/stripe`)  
**Dispatch:** `./fetchsandbox we have a stripe webhook bug — payments getting marked paid 2-3 times. fix it with proof.`

---

## Summary

Payments were being marked paid 2–3 times because the webhook handler deduplicated on `stripe-webhook-id` (a per-delivery header that rotates on every Stripe retry) instead of `event["id"]` (stable across retries). The fix keys idempotency on `event["id"]` after signature verification.

---

## Symptom

- Orders transitioned to `paid` multiple times for a single successful payment.
- Observed 2–3 duplicate side effects, matching Stripe's default webhook retry behaviour.

---

## Root Cause

| What the code did | Why it failed |
|---|---|
| Deduped on `request.headers["stripe-webhook-id"]` | Stripe assigns a **new** delivery id on each retry attempt |
| Assumed unique delivery id = unique event | Retries carry the **same** `event["id"]` with a different delivery id |

FetchSandbox brain matched bug pattern `webhook_duplicate_side_effect` (confidence 0.95).

**Likely cause (from brain):**

> Idempotency key uses the per-delivery webhook id (rotates on retry) instead of the stable event.id. Stripe retries 2–3× with the SAME event.id but a NEW delivery id, so dedup-by-delivery lets every retry through and re-fires the side effect.

---

## Reproduction

| Parameter | Value |
|---|---|
| Spec | `stripe` |
| Workflow | `accept_payment` |
| Scenario | `webhook_retries` |
| Sandbox ID | `1d2fe06464` |

### Proof receipts

| Phase | Receipt URL |
|---|---|
| Before fix | https://fetchsandbox.com/runs/1d2fe06464?flow=run_922d95c6-2192-4374-b8a5-0a2f7f3db8e6 |
| After fix | https://fetchsandbox.com/runs/1d2fe06464?flow=run_3ead7926-c527-4aa7-8495-1834a6457d5d |

Both runs: `accept_payment` + `webhook_retries` — **passed**.

---

## Fix Applied

**File:** `main.py` — `stripe_webhook` handler

**Before:** `processed_webhook_ids` keyed on `stripe-webhook-id` header.

**After:** `processed_event_ids` keyed on `event["id"]` after `construct_event`.

```python
event_id = event["id"]
if event_id in processed_event_ids:
    return {"received": True, "deduped": True}
processed_event_ids.add(event_id)
```

Duplicate retries now short-circuit with `{"received": True, "deduped": True}` before the order status is updated.

---

## Audit Checklist

| Item | Status | Notes |
|---|---|---|
| Handler dedupes on `event.id`, not per-delivery webhook id | ✅ Fixed | `processed_event_ids` uses `event["id"]` |
| Atomic dedup primitive (DB UNIQUE or Redis SETNX) | ⚠️ Open | Still an in-memory `set` with check-then-add |
| Dedup store survives process restart | ⚠️ Open | In-memory only — lost on restart |
| Multi-worker safe (concurrent deliveries) | ⚠️ Open | No shared atomic store across processes |
| Side effect + dedup record atomic together | ⚠️ Open | Not in same DB transaction |

---

## Production Recommendations

1. Replace the in-memory `set` with a `processed_webhook_events` table and a `UNIQUE` constraint on `event_id`.
2. Insert the event id atomically; on duplicate-key error, return `{"received": True, "deduped": True}`.
3. Run the order status update in the same DB transaction as the dedup insert.
4. Alternatively, use Redis `SETNX` with `event["id"]` as the key and a sensible TTL.

---

## Files Touched

| File | Change |
|---|---|
| `main.py` | Renamed `processed_webhook_ids` → `processed_event_ids`; dedup key `stripe-webhook-id` → `event["id"]`; updated handler docstring |

---

## FetchSandbox Brain Reference

- **Bug pattern:** `webhook_duplicate_side_effect`
- **Intent class:** `debug`
- **Matched signals:** `spec:stripe`, `bug_pattern:webhook_duplicate_side_effect`, `bug_pattern_workflow:accept_payment`, `bug_pattern_scenario:webhook_retries`
