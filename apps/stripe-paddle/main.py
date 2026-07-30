"""Apex Billing — migration-in-flight billing service.

Handles Stripe (legacy) and Paddle (new) subscriptions simultaneously.
Routes events by provider; unified subscription store.

Surface:
  POST /subscriptions            create a stub subscription record
  POST /subscriptions/{id}/pay   create a Stripe PaymentIntent (Stripe subs only)
  POST /subscriptions/{id}/refund  refund a Stripe payment
  POST /stripe-webhook           handle Stripe subscription + invoice events
  POST /paddle-webhook           handle Paddle subscription events
  GET  /subscriptions/{id}       current state + access flag
"""
from __future__ import annotations

import os
import uuid

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel
import stripe

app = FastAPI(title="Apex Billing")

STRIPE_API_KEY = "sk_test_demo"
STRIPE_WEBHOOK_SECRET = "whsec_demo"
stripe.api_key = STRIPE_API_KEY
if os.environ.get("STRIPE_API_BASE"):
    stripe.api_base = os.environ["STRIPE_API_BASE"]

subscriptions: dict[str, dict] = {}
processed_stripe_ids: set[str] = set()


class CreateSubReq(BaseModel):
    provider: str  # "stripe" or "paddle"
    email: str
    provider_sub_id: str = ""
    amount_cents: int = 2999


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
        "amount_cents": body.amount_cents,
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

    webhook_delivery_id = request.headers.get("stripe-webhook-id", "")
    if event["id"] in processed_stripe_ids:
        return {"received": True, "deduped": True}
    processed_stripe_ids.add(event["id"])

    event_type = event["type"]
    obj = event["data"]["object"].to_dict()

    if event_type == "customer.subscription.created":
        provider_sub_id = obj.get("id", "")
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


@app.post("/subscriptions/{sub_id}/pay")
def pay_subscription(sub_id: str) -> dict:
    sub = subscriptions.get(sub_id)
    if not sub:
        raise HTTPException(404, "Subscription not found")
    if sub["provider"] != "stripe":
        raise HTTPException(400, "Direct pay only supported for Stripe subscriptions")
    if sub["status"] != "pending":
        raise HTTPException(400, f"Cannot pay a {sub['status']} subscription")

    intent = stripe.PaymentIntent.create(
        amount=sub.get("amount_cents", 2999),
        currency="usd",
        receipt_email=sub["email"],
        metadata={"subscription_id": sub_id},
    )
    sub["payment_intent_id"] = intent["id"]
    sub["status"] = "active"
    sub["access"] = True
    return {
        "payment_intent_id": intent["id"],
        "client_secret": intent["client_secret"],
        "amount": intent["amount"],
    }


@app.post("/subscriptions/{sub_id}/refund")
def refund_subscription(sub_id: str) -> dict:
    sub = subscriptions.get(sub_id)
    if not sub:
        raise HTTPException(404, "Subscription not found")
    if sub["status"] != "active":
        raise HTTPException(400, "Only active subscriptions can be refunded")

    pi_id = sub.get("payment_intent_id")
    if not pi_id:
        raise HTTPException(400, "No payment found to refund")

    refund = stripe.Refund.create(payment_intent=pi_id)
    sub["status"] = "refunded"
    sub["access"] = False
    return {"refund_id": refund["id"], "status": refund["status"]}


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
        sub_id = (data.get("custom_data") or {}).get("subscription_id")
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
