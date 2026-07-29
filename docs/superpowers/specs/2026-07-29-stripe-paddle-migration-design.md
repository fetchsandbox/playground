# Apex Billing — Stripe + Paddle Migration-in-Flight Design

**Date:** 2026-07-29  
**Location:** `apps/stripe-paddle/`  
**Status:** Approved

---

## Scenario

Apex Billing is mid-migration from Stripe to Paddle. Legacy customers retain Stripe subscriptions; new customers onboard to Paddle. Both webhook streams run simultaneously. The app routes events by provider and maintains a unified subscription store.

---

## Architecture

Single FastAPI service with an in-memory `subscriptions` dict. Each record carries a `provider` field (`"stripe"` or `"paddle"`) to distinguish origin.

```
POST /subscriptions          create a stub record (provider + email)
POST /stripe-webhook         handle Stripe subscription + invoice events
POST /paddle-webhook         handle Paddle subscription events
GET  /subscriptions/{id}     current state + access flag
```

### State machine (both providers)

```
pending → active → canceled
```

### Stripe events handled

| Event | Transition |
|---|---|
| `customer.subscription.created` | → `pending` |
| `invoice.paid` | → `active` |
| `customer.subscription.deleted` | → `canceled` |

### Paddle events handled

| Event | Transition |
|---|---|
| `subscription.created` | → `pending` |
| `subscription.activated` | → `active` |
| `subscription.canceled` | → `canceled` |

---

## Data model

```python
subscriptions[sub_id] = {
    "id": sub_id,
    "provider": "stripe" | "paddle",
    "email": str,
    "status": "pending" | "active" | "canceled",
    "access": bool,
    "provider_sub_id": str,  # Stripe sub_xxx or Paddle sub_xxx
}
```

---

## Bugs planted

### Bug 1 — Stripe idempotency (double-processing)

**Location:** `POST /stripe-webhook`  
**Code pattern:**
```python
webhook_delivery_id = request.headers.get("stripe-webhook-id", "")
if event["id"] in processed_stripe_ids:        # checks event id
    return {"received": True, "deduped": True}
processed_stripe_ids.add(webhook_delivery_id)  # stores delivery id
```
**Effect:** `event["id"]` is never in `processed_stripe_ids` (which stores delivery IDs). Every Stripe webhook replay double-processes — `invoice.paid` fires twice, activating an already-active sub and resetting timestamps.

**Fix:** Use the same key for both check and add — either `event["id"]` for both, or the delivery header for both.

---

### Bug 2 — Paddle wrong-field routing (silent no-op)

**Location:** `POST /paddle-webhook`, `subscription.activated` handler  
**Code pattern:**
```python
sub_id = data.get("metadata", {}).get("subscription_id")  # Stripe-style
```
**Effect:** Paddle uses `custom_data`, not `metadata`. `sub_id` is always `None`. `subscription.activated` events silently do nothing — subscriptions remain stuck in `pending` forever and `access` is never set to `True`.

**Fix:** Read `data.get("custom_data", {}).get("subscription_id")`.

---

## Stack

- FastAPI, Pydantic
- In-memory store (Postgres in prod)
- FetchSandbox dispatch convention (CLAUDE.md)
- `stripe` SDK for webhook signature verification
- No Paddle SDK — raw JSON webhook body

---

## Files

```
apps/stripe-paddle/
  main.py           # FastAPI app with both bugs planted
  CLAUDE.md         # FetchSandbox dispatch convention
  README.md         # Surface + run instructions
  requirements.txt  # fastapi, uvicorn, stripe
```
