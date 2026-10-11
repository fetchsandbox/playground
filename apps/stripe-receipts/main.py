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
import urllib.error
import asyncio
import re
import store

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
import stripe

app = FastAPI(title="Acme Orders")
RUNTIME_INSTANCE_ID = uuid.uuid4().hex


@app.get("/verification/runtime")
def runtime_identity():
    """Read-only process identity; restarting is the native owner's operation."""
    return {"instance_id": RUNTIME_INSTANCE_ID}

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
        # Do not log raw Stripe bodies: they can contain client secrets and PII.
        try:
            safe = json.loads(text)
            print(f"[webhook] event_id={safe.get('id')} type={safe.get('type')}", flush=True)
        except ValueError:
            print("[webhook] malformed JSON", flush=True)
    response = await call_next(request)
    print(f"[http] {request.method} {request.url.path} -> {response.status_code}", flush=True)
    return response

STRIPE_API_KEY = os.environ.get("STRIPE_API_KEY", "sk_test_demo")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "whsec_demo")
stripe.api_key = STRIPE_API_KEY
stripe.api_base = os.environ.get("STRIPE_API_BASE", "https://api.stripe.com")
stripe.default_http_client = stripe.http_client.RequestsClient(timeout=8)
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
            "Idempotency-Key": "receipt/" + order["id"],
        }))
    with urllib.request.urlopen(req, timeout=12) as response:
        return json.load(response)

CATALOG = {"mug": 1000, "hat": 1000, "poster": 1000}


class CreateOrderReq(BaseModel):
    sku: str
    quantity: int = Field(strict=True, ge=1, le=100)
    customer_email: str = Field(max_length=254)

    @field_validator("sku")
    @classmethod
    def known_sku(cls, value):
        if value not in CATALOG:
            raise ValueError("Unknown product")
        return value

    @field_validator("customer_email")
    @classmethod
    def valid_email(cls, value):
        if not re.fullmatch(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", value):
            raise ValueError("Invalid email address")
        return value


class PayOrderReq(BaseModel):
    payment_method: str = Field(default="pm_card_visa", min_length=3, max_length=128, pattern=r"^pm_[A-Za-z0-9_]+$")


@app.post("/orders")
def create_order(body: CreateOrderReq) -> dict:
    order_id = f"order_{uuid.uuid4().hex[:8]}"
    order = {
        "id": order_id,
        "sku": body.sku,
        "quantity": body.quantity,
        "email": body.customer_email,
        "status": "pending",
        "amount_cents": CATALOG[body.sku] * body.quantity,
        "receipt_ids": [], "receipt_status": "not_due", "archived": False,
    }
    with store.transaction() as db:
        store.put(db, order)
    return order


@app.get("/orders")
def list_orders() -> dict:
    """Read-only collection so a verifier can count saved orders.

    This does not handle webhooks or change signature checks.
    """
    with store.read() as db:
        return {"orders": [o for o in store.all_orders(db) if not o.get("archived")]}


@app.get("/verification/succeeded-event")
def succeeded_event() -> dict:
    """Read a payment event this process already accepted.

    Signature verification stays in the Stripe webhook handler.
    """
    for order in list_orders()["orders"]:
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
        order = get_order(order_id)
        if not order:
            raise HTTPException(404, "Order not found")
        if order.get("status") == "paid" and order.get("receipt_ids"):
            return order
        if time.monotonic() >= deadline:
            return order
        time.sleep(0.05)


@app.get("/orders/{order_id}")
def get_order(order_id: str) -> dict:
    with store.read() as db:
        order = store.get(db, order_id)
    if not order:
        raise HTTPException(404, "Order not found")
    return order


@app.post("/orders/{order_id}/pay")
def pay_order(order_id: str, body: PayOrderReq | None = None) -> dict:
    payment_method = (body or PayOrderReq()).payment_method
    # Save the PI before confirming: its webhook may arrive before confirm returns.
    with store.transaction() as db:
        order = store.get(db, order_id)
        if not order or order.get("archived"):
            raise HTTPException(404, "Order not found")
        if order["status"] not in ("pending", "payment_failed"):
            raise HTTPException(409, "Order is not payable")
        if order.get("payment_intent_id"):
            intent = stripe.PaymentIntent.retrieve(order["payment_intent_id"], headers=provider_headers())
        else:
            intent = stripe.PaymentIntent.create(
                amount=order["amount_cents"], currency="usd", metadata={"order_id": order_id},
                receipt_email=order["email"], payment_method=payment_method,
                payment_method_types=["card"], headers=provider_headers(),
                idempotency_key="payment/" + order_id,
            )
            order["payment_intent_id"] = intent["id"]
            store.put(db, order)
    if intent["status"] != "succeeded":
        try:
            intent = stripe.PaymentIntent.confirm(intent["id"], payment_method=payment_method,
                                                  headers=provider_headers(),
                                                  idempotency_key="confirm/" + order_id + "/" + payment_method)
        except stripe.error.CardError as exc:
            raise HTTPException(402, "Payment declined; use another payment method") from exc
    print(f"[pay] order {order_id} intent {intent['id']} status {intent['status']}", flush=True)
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

    return await asyncio.to_thread(process_event, event)


def _metadata_order_id(obj):
    return (obj.get("metadata") or {}).get("order_id") or obj.get("metadata[order_id]")


def settle_payment(order_id, payment, event_id=None, event_type=None):
    """Commit payment independently; retry the same durable email intent on failure.

    The demo serializes receipt writes with a DB transaction. Resend's key
    handles the crash window between external acceptance and local commit.
    After its 24-hour key window, ambiguous sends need manual reconciliation.
    """
    with store.transaction() as db:
        order = store.get(db, order_id)
        if not order:
            raise HTTPException(409, "Payment references an unknown order")
        if order.get("archived"):
            raise HTTPException(409, "Archived order requires manual reconciliation")
        if (payment.get("id") != order.get("payment_intent_id") or
                _metadata_order_id(payment) != order_id or
                payment.get("amount") != order["amount_cents"] or
                payment.get("currency") != "usd"):
            raise HTTPException(409, "Payment identity, amount or currency mismatch")
        if order["status"] == "refunded":
            return {"received": True, "terminal_state_preserved": True}
        if payment.get("status") != "succeeded":
            if order["status"] != "paid":
                order["status"] = "payment_failed" if payment.get("last_payment_error") else "pending"
                store.put(db, order)
            return {"received": True, "payment_status": payment.get("status")}
        order["status"] = "paid"
        order["receipt_status"] = "sent" if order["receipt_ids"] else "pending"
        if event_id:
            order["stripe_event_id"] = event_id
        order.setdefault("receipt_attempted_at", time.time())
        store.put(db, order)
    with store.transaction() as db:
        order = store.get(db, order_id)
        if not order["receipt_ids"]:
            if time.time() - order["receipt_attempted_at"] >= 24 * 3600:
                raise HTTPException(409, "Ambiguous receipt exceeded provider key window; reconcile manually")
            try:
                receipt = send_receipt(order)
                if not isinstance(receipt.get("id"), str) or not receipt["id"]:
                    raise ValueError("Provider returned no receipt identity")
            except (urllib.error.URLError, TimeoutError, ValueError) as exc:
                # No retry loop on authentication failures. Redelivery/reconcile
                # is bounded by the caller and uses the same idempotency key.
                raise HTTPException(503, "Receipt not confirmed; payment saved, safe retry required") from exc
            order["receipt_ids"] = [receipt["id"]]
            order["receipt_status"] = "sent"
            store.put(db, order)
        if event_id:
            db.execute("INSERT OR IGNORE INTO events(id,order_id,type) VALUES (?,?,?)",
                       (event_id, order_id, event_type))
    return {"received": True, "receipt_id": order["receipt_ids"][0]}


def process_event(event):
    event_id, event_type = event.get("id"), event["type"]
    if not event_id:
        raise HTTPException(400, "Missing event id")
    with store.transaction() as db:
        if db.execute("SELECT 1 FROM events WHERE id=?", (event_id,)).fetchone():
            return {"received": True, "deduped": True}
    obj = event["data"]["object"]
    if event_type in ("payment_intent.succeeded", "payment_intent.payment_failed"):
        order_id = _metadata_order_id(obj)
        if not order_id:
            raise HTTPException(409, "Missing order identity")
        # An old failure must not overwrite a later payment. Current provider
        # state decides; event timestamps do not establish a total ordering.
        current = stripe.PaymentIntent.retrieve(obj["id"], headers=provider_headers())
        return settle_payment(order_id, current, event_id, event_type)
    with store.transaction() as db:
        order_id = None
        if event_type == "charge.refunded":
            for order in store.all_orders(db):
                if order.get("payment_intent_id") == obj.get("payment_intent"):
                    if obj.get("refunded") is not True:
                        raise HTTPException(409, "Partial refund does not establish fully refunded order")
                    order["status"] = "refunded"
                    order_id = order["id"]
                    store.put(db, order)
                    break
        db.execute("INSERT OR IGNORE INTO events(id,order_id,type) VALUES (?,?,?)",
                   (event_id, order_id, event_type))
    return {"received": True}


@app.post("/orders/{order_id}/refund")
def refund_order(order_id: str) -> dict:
    order = get_order(order_id)
    if order["status"] != "paid":
        raise HTTPException(409, "Only paid orders can be refunded")
    refund = stripe.Refund.create(payment_intent=order["payment_intent_id"],
                                  headers=provider_headers(), idempotency_key="refund/" + order_id)
    if refund["status"] == "succeeded":
        with store.transaction() as db:
            current = store.get(db, order_id)
            current["status"] = "refunded"
            store.put(db, current)
    return {"refund_id": refund["id"], "status": refund["status"]}


@app.post("/orders/{order_id}/reconcile")
def reconcile_order(order_id: str) -> dict:
    order = get_order(order_id)
    if not order.get("payment_intent_id"):
        raise HTTPException(409, "Order has no payment to reconcile")
    current = stripe.PaymentIntent.retrieve(order["payment_intent_id"], headers=provider_headers())
    settle_payment(order_id, current)
    return get_order(order_id)


@app.get("/orders/{order_id}/payment-events")
def payment_events(order_id: str) -> dict:
    """Read provider-recorded events for this payment, including missed callbacks."""
    order = get_order(order_id)
    if not order.get("payment_intent_id"):
        raise HTTPException(409, "Order has no payment")
    events = stripe.Event.list(limit=100, headers=provider_headers())
    matching = [e for e in events["data"] if e["data"]["object"].get("id") == order["payment_intent_id"]]
    def rows(event_type):
        return [{"id": e["id"], "type": e["type"]} for e in matching if e["type"] == event_type]
    return {"order_id": order_id, "events": rows("payment_intent.succeeded"),
            "failed_events": rows("payment_intent.payment_failed")}


@app.delete("/orders/{order_id}")
def archive_order(order_id: str) -> dict:
    with store.transaction() as db:
        order = store.get(db, order_id)
        if not order:
            raise HTTPException(404, "Order not found")
        order["archived"] = True
        store.put(db, order)
    return {"id": order_id, "archived": True, "ledger_retained": True}
