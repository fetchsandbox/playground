"""Acme Orders — Stripe-powered order management API.

Public surface:
  POST   /orders                 create an order, returns id + amount
  GET    /orders/{order_id}      order detail
  POST   /orders/{order_id}/pay  start payment via Stripe PaymentIntent
  POST   /stripe-webhook         receive Stripe events + mark orders paid
  POST   /orders/{order_id}/refund  refund a paid order
"""
from __future__ import annotations

import uuid

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel
import stripe

app = FastAPI(title="Acme Orders")

STRIPE_API_KEY = "sk_test_demo"
STRIPE_WEBHOOK_SECRET = "whsec_demo"
stripe.api_key = STRIPE_API_KEY

# Tiny in-memory store — would be Postgres in prod.
orders: dict[str, dict] = {}
processed_webhook_ids: set[str] = set()


class CreateOrderReq(BaseModel):
    sku: str
    quantity: int
    customer_email: str


@app.post("/orders")
def create_order(body: CreateOrderReq) -> dict:
    order_id = f"order_{uuid.uuid4().hex[:8]}"
    orders[order_id] = {
        "id": order_id,
        "sku": body.sku,
        "quantity": body.quantity,
        "email": body.customer_email,
        "status": "pending",
        "amount_cents": 1000 * body.quantity,
    }
    return orders[order_id]


@app.get("/orders/{order_id}")
def get_order(order_id: str) -> dict:
    order = orders.get(order_id)
    if not order:
        raise HTTPException(404, "Order not found")
    return order


@app.post("/orders/{order_id}/pay")
def pay_order(order_id: str) -> dict:
    order = orders.get(order_id)
    if not order:
        raise HTTPException(404, "Order not found")
    if order["status"] != "pending":
        raise HTTPException(400, f"Order is {order['status']}, not pending")

    intent = stripe.PaymentIntent.create(
        amount=order["amount_cents"],
        currency="usd",
        metadata={"order_id": order_id},
        receipt_email=order["email"],
    )
    orders[order_id]["payment_intent_id"] = intent["id"]
    return {
        "payment_intent_id": intent["id"],
        "client_secret": intent["client_secret"],
        "amount": intent["amount"],
    }


@app.post("/stripe-webhook")
async def stripe_webhook(
    request: Request,
    stripe_signature: str = Header(None),
) -> dict:
    """Handle Stripe events and update order status.

    Idempotent via event.id — Stripe retries the same event with a new
    per-delivery webhook id, so dedup must use the stable event id.
    """
    payload = await request.body()

    try:
        event = stripe.Webhook.construct_event(
            payload, stripe_signature, STRIPE_WEBHOOK_SECRET,
        )
    except (ValueError, stripe.error.SignatureVerificationError):
        raise HTTPException(400, "Invalid signature")

    event_id = event["id"]
    if event_id in processed_webhook_ids:
        return {"received": True, "deduped": True}
    processed_webhook_ids.add(event_id)

    event_type = event["type"]
    obj = event["data"]["object"]

    if event_type == "payment_intent.succeeded":
        order_id = obj.get("metadata", {}).get("order_id")
        if order_id and order_id in orders:
            orders[order_id]["status"] = "paid"
            orders[order_id]["paid_at"] = event["created"]
            print(f"[db] order {order_id} marked paid")

    elif event_type == "payment_intent.payment_failed":
        order_id = obj.get("metadata", {}).get("order_id")
        if order_id and order_id in orders:
            orders[order_id]["status"] = "payment_failed"
            orders[order_id]["failure_code"] = (
                obj.get("last_payment_error", {}).get("code")
            )

    elif event_type == "charge.refunded":
        pi_id = obj.get("payment_intent")
        for order_id, order in orders.items():
            if order.get("payment_intent_id") == pi_id:
                orders[order_id]["status"] = "refunded"
                break

    return {"received": True}


@app.post("/orders/{order_id}/refund")
def refund_order(order_id: str) -> dict:
    order = orders.get(order_id)
    if not order:
        raise HTTPException(404, "Order not found")
    if order["status"] != "paid":
        raise HTTPException(400, "Only paid orders can be refunded")

    refund = stripe.Refund.create(payment_intent=order["payment_intent_id"])
    orders[order_id]["status"] = "refunded"
    return {"refund_id": refund["id"], "status": refund["status"]}
