# E2E Audit — Aterna Cloud Billing (02-billing)
**Date:** 2026-07-25  
**Sandbox:** https://fetchsandbox.com/runs/6e850d86fb  
**Result:** 12/13 workflows passed · 1 failed · 2 code bugs fixed/flagged

---

## Workflow Results

| Workflow | Status | Steps |
|---|---|---|
| subscription_lifecycle | **FAIL** | 1/2 |
| create_transaction | pass | 3/3 |
| product_catalog_setup | pass | 4/4 |
| transactions_completed | pass | 5/5 |
| transactions_canceled | pass | 4/4 |
| products_archived | pass | 4/4 |
| prices_archived | pass | 4/4 |
| discounts_archived | pass | 4/4 |
| discounts_expired | pass | 4/4 |
| discounts_used | pass | 4/4 |
| customers_create | pass | 3/3 |
| notification_settings_create | pass | 2/2 |
| additional_event_monitoring | pass | 4/4 |

### subscription_lifecycle failure

Proof URL: https://fetchsandbox.com/runs/6e850d86fb?flow=run_c8569fa5-f761-4d22-9db4-96b6ec7415b4

- Step 1: GET subscription returned `status: canceled` (expected `trialing`).
- Step 2: POST `/activate` → 422. Paddle rejects activation of a canceled subscription.
- **Root cause:** Sandbox seed state mismatch — the subscription was already canceled (likely from a prior `01-subscriptions` run sharing the same fixture).
- **Impact on this app:** `main.py` does not handle subscription events, so no code change needed here. Flag for consideration: if Aterna Cloud ever needs to react to `subscription.activated` (e.g., grant credits on trial conversion), that handler is missing.

---

## Code Bugs Fixed

### Bug 1 — Duplicate transaction processing (FIXED)

**File:** `main.py:28-31`  
**Severity:** High

Paddle retries webhooks on timeout or non-2xx. Without an idempotency guard the same `transaction_id` could be credited multiple times, inflating an account's balance arbitrarily.

**Before:**
```python
acc["credits"] += credits
acc["transactions"].append({"transaction_id": data.get("id"), "credits": credits})
```

**After:**
```python
already_seen = any(t["transaction_id"] == txn_id for t in acc["transactions"])
if not already_seen:
    credits = quantity * CREDITS_PER_UNIT
    acc["credits"] += credits
    acc["transactions"].append({"transaction_id": txn_id, "credits": credits})
```

### Bug 2 — Phantom credit on missing quantity (FIXED)

**File:** `main.py:26`  
**Severity:** Medium

`quantity` defaulted to `1` when `line_items` was absent or malformed. A malformed event would silently credit 100 units to the account. Changed default to `0`.

**Before:** `.get("quantity", 1)`  
**After:** `.get("quantity", 0)`

---

## Honest Limits (Out of Scope)

- **Webhook signature verification** — No `Paddle-Signature` header validation. Any caller can POST to `/webhook` and inflate balances. Fix: verify HMAC-SHA256 against the secret key before processing.
- **Persistence across restarts** — `accounts` is an in-memory dict. All balance state is lost on process restart. Not tested here.
- **Concurrent dedup** — The idempotency check (`any(...)`) is not safe under concurrent requests (race condition). A DB-level unique constraint on `transaction_id` would be needed for production.
- **`subscription.activated` handler missing** — If trial-to-paid conversion should grant credits, no handler exists.
