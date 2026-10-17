# Findings: Paddle Upgrades (04-upgrades)

**App:** `apps/paddle/04-upgrades` — Orion Plans subscription upgrade/downgrade service  
**Date:** 2026-07-26  
**Author:** Ajit Gupta  
**Sandbox:** https://fetchsandbox.com/runs/e0a90fe8c2  
**Before receipt:** https://fetchsandbox.com/runs/e0a90fe8c2?flow=run_d2fb167d-ddb3-408c-b918-be28f708a719  
**After receipt:** https://fetchsandbox.com/runs/e0a90fe8c2?flow=run_f540620d-71c8-4a27-91d4-1f127698b636

---

## Bugs Found and Fixed

### Bug 1 — Out-of-order event handling: `activated` and `updated` silently no-op

**File:** `main.py:36,41`  
**Pattern:** `out_of_order_subscription_state`

Both `subscription.activated` and `subscription.updated` handlers guarded with `if sid in subscriptions:`. Paddle delivers webhooks at-least-once and **unordered** — its billing and subscription services emit independently, so `activated` or `updated` can legitimately arrive before `created`. When they do, the guard silently drops the event: the status is never written, the plan is never updated, and the customer is left in a broken state with no error raised.

**Fix:** Replaced `if sid in subscriptions:` with `subscriptions.setdefault(sid, {...})` (upsert semantics). Any event can now arrive first and will initialize the record; the subsequent `created` event overwrites cleanly.

---

### Bug 2 — Hardcoded `"created"` status on `subscription.created`

**File:** `main.py:27`

`subscription.created` always wrote `"status": "created"` regardless of what Paddle sent. Paddle's actual initial status can be `"trialing"` (trial subscriptions) or `"active"` (direct activations). The hardcoded value immediately diverges from Paddle's canonical state.

**Fix:** Changed to `data.get("status", "created")` so the status reflects what Paddle reports.

---

### Bug 3 — `subscription.updated` never updates `status`

**File:** `main.py:41–45`

The `subscription.updated` handler updated `plan_id` and `updated_at` but not `status`. Plan upgrades/downgrades can coincide with a status transition (e.g., resuming a paused subscription via an upgrade). The local record's status would silently lag behind Paddle's.

**Fix:** Added `sub["status"] = data.get("status", sub.get("status", ""))` so any status change carried in the update event is written through.

---

## check_for Audit (from brain)

| Item | Status |
|---|---|
| Handler does NOT assume event ordering — every handler tolerates being called first OR last | ✅ Fixed (upsert on all three handlers) |
| Upsert semantics so events arriving in any order converge to the right state | ✅ Fixed |
| Idempotency check still in place — out-of-order doesn't mean duplicate | ✅ Not applicable (in-memory dict; `setdefault` is idempotent by key) |
| Use a state machine that accepts the END state regardless of trigger | ✅ Fixed (status written from event data, not assumed from event type) |
| On any lifecycle event, fetch canonical state from provider API rather than relying on payload | ⚠️ Honest limit — app uses in-memory store; no Paddle API read-back on each event. Acceptable for demo; prod would need a reconciliation job. |
| Reconciliation job: periodically sync from provider's list-subscriptions endpoint | ⚠️ Honest limit — out of scope for this app; flag for production readiness. |
