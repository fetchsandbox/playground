# Findings: Paddle Seats (09-seats)

**App:** `apps/paddle/09-seats` — Grid Seats per-seat subscription management API  
**Date:** 2026-07-26  
**Author:** Ajit Gupta  
**Sandbox:** https://fetchsandbox.com/runs/e0a90fe8c2  
**Before receipt:** https://fetchsandbox.com/runs/e0a90fe8c2?flow=run_01d3c95a-72a0-4abe-b63f-aa29ca1d929f  
**After receipt:** https://fetchsandbox.com/runs/e0a90fe8c2?flow=run_2739cedc-cab5-4f40-9f7d-cd84677b1fab

---

## Bugs Found and Fixed

### Bug 1 — Out-of-order event handling: `activated` and `updated` silently no-op

**File:** `main.py:38,43`  
**Pattern:** `out_of_order_subscription_state`

Both `subscription.activated` and `subscription.updated` handlers were guarded with `if team_id in teams:`. Paddle delivers webhooks at-least-once and **unordered** — its billing and subscription services emit independently, so `activated` or `updated` can legitimately arrive before `created`. When they do, the guard silently drops the event: the status is never written, seats are never updated, and the team is left in a broken state with no error raised.

**Fix:** Replaced `if team_id in teams:` with `teams.setdefault(team_id, {...})` (upsert semantics) on all three handlers. Any event can now arrive first and will initialize the record; subsequent events overwrite cleanly.

---

### Bug 2 — Hardcoded `"created"` status on `subscription.created`

**File:** `main.py:34`

`subscription.created` always wrote `"status": "created"` regardless of what Paddle sent. Paddle's actual initial status can be `"trialing"` (trial subscriptions) or `"active"` (direct activations without a trial). The hardcoded value immediately diverges from Paddle's canonical state.

**Fix:** Changed to `data.get("status", "created")` so the status reflects what Paddle reports.

---

### Bug 3 — `subscription.updated` never updates `updated_at`

**File:** `main.py:44–47`

The `subscription.updated` handler updated `seats` but never updated `updated_at`. After a seat change, the team record's timestamp permanently lagged behind Paddle's reality.

**Fix:** Added `team["updated_at"] = occurred_at` to the `subscription.updated` handler.

---

### Bug 4 — `subscription.updated` never updates `status`

**File:** `main.py:44–47`

The `subscription.updated` handler updated `seats` but not `status`. Seat changes can coincide with status transitions (e.g., a team downgrades from active to past_due). The local record's status would silently diverge from Paddle's.

**Fix:** Added `team["status"] = data.get("status", team.get("status", ""))` so any status change carried in the update event is written through.

---

## check_for Audit (from brain)

| Item | Status |
|---|---|
| Handler does NOT assume event ordering — every handler tolerates being called first OR last | ✅ Fixed (upsert on all three handlers) |
| Upsert semantics so events arriving in any order converge to the right state | ✅ Fixed |
| Idempotency check still in place — out-of-order doesn't mean duplicate | ✅ Not applicable (in-memory dict; `setdefault` is idempotent by key) |
| Use a state machine that accepts the END state regardless of trigger | ✅ Fixed (status written from event data, not hardcoded from event type) |
| On any lifecycle event, fetch canonical state from provider API rather than relying on payload | ⚠️ Honest limit — app uses in-memory store; no Paddle API read-back on each event. Acceptable for demo; prod would need a reconciliation job. |
| Reconciliation job: periodically sync from provider's list-subscriptions endpoint | ⚠️ Honest limit — out of scope for this app; flag for production readiness. |
