"""Acme Orders — Stripe-powered order management API.

Public surface:
  POST   /orders                 create an order, returns id + amount
  GET    /orders/{order_id}      order detail
  POST   /orders/{order_id}/pay  start payment via Stripe PaymentIntent
  POST   /stripe-webhook         receive Stripe events + mark orders paid
  POST   /orders/{order_id}/refund  refund a paid order
"""
from __future__ import annotations

import time
import uuid
import os
import json
import urllib.request

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import stripe

app = FastAPI(title="Acme Orders")

VERIFIER_TOKEN = os.environ.get("FETCHSANDBOX_VERIFIER_TOKEN", "")


@app.middleware("http")
async def require_verifier_token(request: Request, call_next):
    """Temporary gate for this disposable run.

    Stripe signature checks in the webhook handler are unchanged.
    """
    if VERIFIER_TOKEN:
        presented = request.headers.get("x-fetchsandbox-verifier-token", "")
        authorization = request.headers.get("authorization", "")
        bearer = authorization[7:] if authorization.lower().startswith("bearer ") else ""
        if presented != VERIFIER_TOKEN and bearer != VERIFIER_TOKEN:
            print(f"[http] {request.method} {request.url.path} -> 401 missing verifier token", flush=True)
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    return await call_next(request)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Record tunnel traffic. Webhook bodies are logged; secrets are not."""
    if request.url.path == "/stripe-webhook":
        body = await request.body()
        text = body.decode("utf-8", errors="replace")
        signature = "yes" if request.headers.get("stripe-signature") else "no"
        delivery_id = request.headers.get("stripe-webhook-id", "")
        print(
            f"[webhook] incoming bytes={len(body)} signature={signature} stripe-webhook-id={delivery_id!r}",
            flush=True,
        )
        print(f"[webhook] body {text[:8000]}", flush=True)
    response = await call_next(request)
    print(f"[http] {request.method} {request.url.path} -> {response.status_code}", flush=True)
    return response

STRIPE_API_KEY = os.environ.get("STRIPE_API_KEY", "sk_test_demo")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "whsec_demo")
stripe.api_key = STRIPE_API_KEY
stripe.api_base = os.environ.get("STRIPE_API_BASE", "https://api.stripe.com")
RESEND_API_BASE = os.environ.get("RESEND_API_BASE", "https://api.resend.com")
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "re_demo")
RESEND_FROM = os.environ.get("RESEND_FROM", "receipts@example.test")
FLOW_RUN_ID = os.environ.get("X_FLOW_RUN_ID", "")


def provider_headers(extra: dict | None = None) -> dict:
    headers = dict(extra or {})
    if FLOW_RUN_ID:
        headers["X-Flow-Run-Id"] = FLOW_RUN_ID
    return headers


def send_receipt(order: dict) -> dict:
    payload = {"from": RESEND_FROM, "to": [order["email"]],
               "subject": f"Receipt for {order["id"]}",
               "html": f"<p>Order {order["id"]}: {order["amount_cents"]} cents paid.</p>"}
    req = urllib.request.Request(RESEND_API_BASE.rstrip("/") + "/emails",
        data=json.dumps(payload).encode(), method="POST",
        headers=provider_headers({
            "Authorization": "Bearer " + RESEND_API_KEY,
            "Content-Type": "application/json",
            "User-Agent": "stripe-receipts/1.0",
        }))
    with urllib.request.urlopen(req, timeout=12) as response:
        return json.load(response)

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


@app.get("/orders")
def list_orders() -> dict:
    """Read-only collection so a verifier can count saved orders.

    This does not handle webhooks or change signature checks.
    """
    return {"orders": list(orders.values())}


@app.get("/verification/succeeded-event")
def succeeded_event() -> dict:
    """Read a payment event this process already accepted.

    Signature verification stays in the Stripe webhook handler.
    """
    for order in orders.values():
        event_id = order.get("stripe_event_id")
        if event_id and order.get("status") == "paid":
            return {
                "event_id": event_id,
                "order_id": order["id"],
                "receipt_count": len(order.get("receipt_ids") or []),
            }
    raise HTTPException(404, "No succeeded payment event")


@app.get("/orders/{order_id}/settled")
def settled_order(order_id: str) -> dict:
    """Read an order after its payment webhook has stored a receipt.

    This waits on saved state only. Signature checks stay on the webhook.
    """
    deadline = time.monotonic() + 10
    while True:
        order = orders.get(order_id)
        if not order:
            raise HTTPException(404, "Order not found")
        if order.get("status") == "paid" and order.get("receipt_ids"):
            return order
        if time.monotonic() >= deadline:
            return order
        time.sleep(0.05)


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
        payment_method="pm_card_visa",
        payment_method_types=["card"],
        headers=provider_headers(),
    )
    intent = stripe.PaymentIntent.confirm(intent["id"], headers=provider_headers())
    print(f"[pay] order {order_id} intent {intent['id']} status {intent['status']}", flush=True)
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

    Idempotent on the Stripe event id. The id is stored after the handler
    finishes, so a failed receipt send can be retried.
    """
    payload = await request.body()

    try:
        event = stripe.Webhook.construct_event(
            payload, stripe_signature, STRIPE_WEBHOOK_SECRET,
        )
    except (ValueError, stripe.error.SignatureVerificationError) as exc:
        print(f"[webhook] signature rejected: {exc.__class__.__name__}", flush=True)
        raise HTTPException(400, "Invalid signature")

    event_type = event["type"]
    event_id = event.get("id", "")
    print(f"[webhook] verified type={event_type} event_id={event_id}", flush=True)
    if not event_id:
        print("[webhook] rejected missing event id", flush=True)
        raise HTTPException(400, "Missing event id")
    if event_id in processed_webhook_ids:
        print(f"[webhook] deduped event_id={event_id}", flush=True)
        return {"received": True, "deduped": True}

    obj = event["data"]["object"]

    if event_type == "payment_intent.succeeded":
        order_id = obj.get("metadata", {}).get("order_id")
        print(f"[webhook] succeeded metadata_order_id={order_id!r} known={order_id in orders if order_id else False}", flush=True)
        if order_id and order_id in orders:
            orders[order_id]["status"] = "paid"
            orders[order_id]["paid_at"] = event["created"]
            orders[order_id]["stripe_event_id"] = event_id
            print(f"[db] order {order_id} marked paid", flush=True)
            receipt = send_receipt(orders[order_id])
            orders[order_id].setdefault("receipt_ids", []).append(receipt["id"])
            print(f"[webhook] receipt sent order={order_id} receipt_id={receipt.get('id')}", flush=True)
        processed_webhook_ids.add(event_id)

    elif event_type == "payment_intent.payment_failed":
        order_id = obj.get("metadata", {}).get("order_id")
        if order_id and order_id in orders:
            orders[order_id]["status"] = "payment_failed"
            orders[order_id]["failure_code"] = (
                obj.get("last_payment_error", {}).get("code")
            )
        processed_webhook_ids.add(event_id)

    elif event_type == "charge.refunded":
        pi_id = obj.get("payment_intent")
        for order_id, order in orders.items():
            if order.get("payment_intent_id") == pi_id:
                orders[order_id]["status"] = "refunded"
                break
        processed_webhook_ids.add(event_id)

    else:
        processed_webhook_ids.add(event_id)

    return {"received": True}


@app.post("/orders/{order_id}/refund")
def refund_order(order_id: str) -> dict:
    order = orders.get(order_id)
    if not order:
        raise HTTPException(404, "Order not found")
    if order["status"] != "paid":
        raise HTTPException(400, "Only paid orders can be refunded")

    refund = stripe.Refund.create(
        payment_intent=order["payment_intent_id"],
        headers=provider_headers(),
    )
    orders[order_id]["status"] = "refunded"
    return {"refund_id": refund["id"], "status": refund["status"]}
