"""Apex Billing — migration-in-flight billing service.

Handles Stripe (legacy) and Paddle (new) subscriptions simultaneously.
Routes events by provider; unified subscription store.

Surface:
  POST /subscriptions        create a stub subscription record
  POST /stripe-webhook       handle Stripe subscription + invoice events
  POST /paddle-webhook       handle Paddle subscription events
  GET  /subscriptions/{id}   current state + access flag
"""
from __future__ import annotations

import uuid

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel
import stripe

app = FastAPI(title="Apex Billing")

STRIPE_API_KEY = "sk_test_demo"
STRIPE_WEBHOOK_SECRET = "whsec_demo"
stripe.api_key = STRIPE_API_KEY

subscriptions: dict[str, dict] = {}

# BUG 1 (idempotency): this set stores stripe-webhook-id delivery headers,
# but the dedup check below reads event["id"] — they never match.
processed_stripe_ids: set[str] = set()


class CreateSubReq(BaseModel):
    provider: str  # "stripe" or "paddle"
    email: str
    provider_sub_id: str = ""


@app.post("/subscriptions")
def create_subscription(body: CreateSubReq) -> dict:
    sub_id = f"sub_{uuid.uuid4().hex[:8]}"
    subscriptions[sub_id] = {
        "id": sub_id,
        "provider": body.provider,
        "email": body.email,
        "status": "pending",
        "access": False,
        "provider_sub_id": body.provider_sub_id,
    }
    return subscriptions[sub_id]


@app.get("/subscriptions/{sub_id}")
def get_subscription(sub_id: str) -> dict:
    sub = subscriptions.get(sub_id)
    if not sub:
        raise HTTPException(status_code=404, detail="Subscription not found")
    return sub


@app.post("/stripe-webhook")
async def stripe_webhook(
    request: Request,
    stripe_signature: str = Header(None),
) -> dict:
    payload = await request.body()

    try:
        event = stripe.Webhook.construct_event(
            payload, stripe_signature, STRIPE_WEBHOOK_SECRET,
        )
    except (ValueError, stripe.error.SignatureVerificationError):
        raise HTTPException(400, "Invalid signature")

    # BUG 1: dedup check reads event["id"] but the set stores the delivery
    # header value — these never match, so replays always double-process.
    webhook_delivery_id = request.headers.get("stripe-webhook-id", "")
    if event["id"] in processed_stripe_ids:
        return {"received": True, "deduped": True}
    processed_stripe_ids.add(webhook_delivery_id)

    event_type = event["type"]
    obj = event["data"]["object"]

    if event_type == "customer.subscription.created":
        provider_sub_id = obj.get("id", "")
        # find matching stub by provider_sub_id or create inline
        for sub in subscriptions.values():
            if sub["provider"] == "stripe" and sub["provider_sub_id"] == provider_sub_id:
                sub["status"] = "pending"
                break

    elif event_type == "invoice.paid":
        provider_sub_id = obj.get("subscription", "")
        for sub in subscriptions.values():
            if sub["provider"] == "stripe" and sub["provider_sub_id"] == provider_sub_id:
                sub["status"] = "active"
                sub["access"] = True
                sub["activated_at"] = event["created"]
                break

    elif event_type == "customer.subscription.deleted":
        provider_sub_id = obj.get("id", "")
        for sub in subscriptions.values():
            if sub["provider"] == "stripe" and sub["provider_sub_id"] == provider_sub_id:
                sub["status"] = "canceled"
                sub["access"] = False
                break

    return {"received": True}


@app.post("/paddle-webhook")
async def paddle_webhook(request: Request) -> dict:
    event = await request.json()
    event_type = event.get("event_type", "")
    data = event.get("data", {})

    if event_type == "subscription.created":
        custom_data = data.get("custom_data") or {}
        sub_id = custom_data.get("subscription_id", "")
        if sub_id and sub_id in subscriptions:
            subscriptions[sub_id]["status"] = "pending"
            subscriptions[sub_id]["provider_sub_id"] = data.get("id", "")

    elif event_type == "subscription.activated":
        # BUG 2: reads "metadata" (Stripe-style) instead of "custom_data"
        # (Paddle's actual field). sub_id is always None — silent no-op.
        sub_id = data.get("metadata", {}).get("subscription_id")
        if sub_id and sub_id in subscriptions:
            subscriptions[sub_id]["status"] = "active"
            subscriptions[sub_id]["access"] = True

    elif event_type == "subscription.canceled":
        custom_data = data.get("custom_data") or {}
        sub_id = custom_data.get("subscription_id", "")
        if sub_id and sub_id in subscriptions:
            subscriptions[sub_id]["status"] = "canceled"
            subscriptions[sub_id]["access"] = False

    return {"received": True}
