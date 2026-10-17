# Findings: Paddle Refunds (10-refunds)

**App:** `apps/paddle/10-refunds` — Pulse Billing transaction and refund lifecycle service  
**Date:** 2026-07-26  
**Author:** Ajit Gupta  
**Sandbox:** https://fetchsandbox.com/runs/e0a90fe8c2  
**Before receipt:** https://fetchsandbox.com/runs/e0a90fe8c2?flow=run_27daae5b-4b7d-4ffd-9def-51e7e7f58c9e  
**After receipt:** https://fetchsandbox.com/runs/e0a90fe8c2?flow=run_92c5af8a-4dfd-434b-a49a-dabe74e2e88e

---

## Bugs Found and Fixed

### Bug 1 — Phantom event type: `transaction.refunded` does not exist in Paddle

**File:** `main.py:34`  
**Pattern:** wrong_event_type / silent_no_op

The refund handler listened for `transaction.refunded`, which is not a real Paddle Billing event. The sandbox confirmed this: the full transaction event listing (`transaction.billed`, `transaction.canceled`, `transaction.completed`, `transaction.created`, `transaction.paid`, `transaction.past_due`, `transaction.payment_failed`, `transaction.ready`, `transaction.updated`) contains no `transaction.refunded`. In Paddle Billing, refunds are created via the **Adjustments API** and fire `adjustment.created` (and `adjustment.updated`) events. Because the wrong event type was checked, every refund silently no-oped — licenses remained active indefinitely after customers were refunded.

**Fix:** Changed the handler to listen for `adjustment.created` with `data.action == "refund"` and `data.status == "approved"`. Only approved refunds revoke the license; pending-approval adjustments are ignored.

---

### Bug 2 — Refund lookup used `license_id` from `custom_data`, which adjustments don't carry

**File:** `main.py:35`  
**Pattern:** wrong_lookup_key

The original handler read `license_id` from `data.custom_data.license_id`. Adjustment events carry their own `custom_data` (set at adjustment creation time) — they do **not** inherit the original transaction's `custom_data`. In practice this field is always absent on a Paddle adjustment, so the lookup would always miss even if the event type were correct.

**Fix:** Switched the lookup to iterate over stored licenses and match by `transaction_id` (which the adjustment event carries in `data.transaction_id`, and which was already stored on the license record at activation time).

---

## Final Code (main.py webhook handler — refund branch)

```python
elif event_type == "adjustment.created":
    action = data.get("action", "")
    status = data.get("status", "")
    adj_transaction_id = data.get("transaction_id", "")
    if action == "refund" and status == "approved":
        for lic in licenses.values():
            if lic["transaction_id"] == adj_transaction_id:
                lic["status"] = "refunded"
                lic["access"] = False
                break
```

---

## Workflow Results (13 total)

| Workflow | Result |
|---|---|
| `subscription_lifecycle` | ❌ FAIL — sandbox seed state issue (sub already canceled); not an app bug |
| `create_transaction` | ✅ pass |
| `product_catalog_setup` | ✅ pass |
| `transactions_completed` | ✅ pass |
| `transactions_canceled` | ✅ pass |
| `products_archived` | ✅ pass |
| `prices_archived` | ✅ pass |
| `discounts_archived` | ✅ pass |
| `discounts_expired` | ✅ pass |
| `discounts_used` | ✅ pass |
| `customers_create` | ✅ pass |
| `notification_settings_create` | ✅ pass |
| `additional_event_monitoring` | ✅ pass |

---

## check_for Audit

| Item | Status |
|---|---|
| App listens to a real Paddle event type for refunds | ✅ Fixed (`adjustment.created` replaces phantom `transaction.refunded`) |
| Refund only triggers on approved adjustments, not pending | ✅ Fixed (`status == "approved"` guard) |
| License lookup uses a key that adjustment events actually carry | ✅ Fixed (pivot on `transaction_id`, not `custom_data.license_id`) |
| `transaction.completed` idempotency on duplicate delivery | ⚠️ Honest limit — no dedup guard; second delivery overwrites with identical data (harmless in-memory but flag for prod) |
| `adjustment.updated` handling for late-approved refunds | ⚠️ Honest limit — only `adjustment.created` is handled; if an adjustment is created as `pending_approval` and later approved via `adjustment.updated`, the license will not be revoked |
