"""Disposable Stripe/Resend QA fixture. Run one worker, on loopback only.

All SKUs cost 1000 USD cents per unit. State is intentionally in memory;
production requires authentication, durable transactions and an outbox.
"""
from __future__ import annotations

import copy
import json
import os
import re
import threading
import urllib.request
from urllib.parse import urlsplit
import uuid

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool
import stripe

app = FastAPI(title="Acme Orders — isolated QA")


def required_setting(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value or value in {"sk_test_demo", "whsec_demo", "re_demo"}:
        raise RuntimeError(f"Configure {name} with an isolated test value")
    return value


def test_endpoint(name: str) -> str:
    value = required_setting(name).rstrip("/")
    url = urlsplit(value)
    loopback = url.scheme == "http" and url.hostname in {"127.0.0.1", "localhost", "::1"}
    twin = (url.scheme == "https" and url.hostname == "fetchsandbox.com"
            and url.port in {None, 443} and re.fullmatch(r"/sandbox/[A-Za-z0-9_-]+", url.path))
    if (not (loopback or twin) or url.username or url.password or url.query or url.fragment
            or (loopback and url.path)):
        raise RuntimeError(f"{name} must be an isolated FetchSandbox twin or loopback provider")
    return value


def test_email(value: str) -> str:
    local = value.partition("@")[0]
    if (not re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@example\.test", value)
            or len(local) > 64 or local.startswith(".") or local.endswith(".") or ".." in local):
        raise ValueError("Use a synthetic address at example.test")
    return value


STRIPE_API_KEY = required_setting("STRIPE_API_KEY")
if not STRIPE_API_KEY.startswith("sk_test_"):
    raise RuntimeError("Only synthetic Stripe test keys are allowed")
STRIPE_WEBHOOK_SECRET = required_setting("STRIPE_WEBHOOK_SECRET")
stripe.api_key = STRIPE_API_KEY
stripe.api_base = test_endpoint("STRIPE_API_BASE")
stripe.default_http_client = stripe.http_client.RequestsClient(timeout=12)
RESEND_API_BASE = test_endpoint("RESEND_API_BASE")
RESEND_API_KEY = required_setting("RESEND_API_KEY")
RESEND_FROM = test_email(os.environ.get("RESEND_FROM", "receipts@example.test"))

# One process only. The lock covers state transitions and their provider calls;
# webhook work runs in a thread so synchronous I/O never blocks the event loop.
orders: dict[str, dict] = {}
processed_webhook_ids: set[str] = set()
state_lock = threading.RLock()


def public_order(order: dict) -> dict:
    return copy.deepcopy({key: value for key, value in order.items() if not key.startswith("_")})


def send_receipt(order: dict) -> dict:
    payload = {"from": RESEND_FROM, "to": [test_email(order["email"])],
               "subject": f"Receipt for {order['id']}",
               "html": f"<p>Order {order['id']}: {order['amount_cents']} cents paid.</p>"}
    req = urllib.request.Request(
        RESEND_API_BASE + "/emails", data=json.dumps(payload).encode(), method="POST",
        headers={"Authorization": "Bearer " + RESEND_API_KEY, "Content-Type": "application/json",
                 "User-Agent": "stripe-receipts-qa/1.0",
                 "Idempotency-Key": f"receipt:{order['id']}:{order['payment_intent_id']}"})
    with urllib.request.urlopen(req, timeout=12) as response:
        receipt = json.load(response)
    if not isinstance(receipt, dict) or not isinstance(receipt.get("id"), str) or not receipt["id"]:
        raise ValueError("Receipt provider omitted its acceptance id")
    return receipt


class CreateOrderReq(BaseModel):
    sku: str = Field(min_length=1, max_length=100)
    quantity: int = Field(strict=True, ge=1, le=99999)
    customer_email: str = Field(max_length=254)

    @field_validator("sku")
    @classmethod
    def valid_sku(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("sku must not be blank")
        return value.strip()

    @field_validator("customer_email")
    @classmethod
    def valid_email(cls, value: str) -> str:
        return test_email(value)


@app.post("/orders")
def create_order(body: CreateOrderReq) -> dict:
    order_id = f"order_{uuid.uuid4().hex}"
    with state_lock:
        orders[order_id] = {
            "id": order_id, "sku": body.sku, "quantity": body.quantity,
            "email": body.customer_email, "status": "pending",
            "amount_cents": 1000 * body.quantity, "currency": "usd",
            "receipt_ids": [], "receipt_status": "not_sent", "amount_refunded": 0,
        }
        return public_order(orders[order_id])


def require_order(order_id: str) -> dict:
    if order_id not in orders:
        raise HTTPException(404, "Order not found")
    return orders[order_id]


@app.get("/orders/{order_id}")
def get_order(order_id: str) -> dict:
    with state_lock:
        return public_order(require_order(order_id))


@app.post("/orders/{order_id}/pay")
def pay_order(order_id: str) -> dict:
    with state_lock:
        order = require_order(order_id)
        if order["status"] not in {"pending", "payment_failed"}:
            raise HTTPException(400, "Order is not awaiting payment")
        if "_payment" not in order:
            try:
                intent = stripe.PaymentIntent.create(
                    amount=order["amount_cents"], currency=order["currency"],
                    metadata={"order_id": order_id},
                    idempotency_key=f"pay:{order_id}",
                )
            except stripe.error.StripeError as exc:
                raise HTTPException(502, "Payment provider unavailable; retry this order") from exc
            if (not intent.get("id") or not intent.get("client_secret")
                    or type(intent.get("amount")) is not int
                    or intent["amount"] != order["amount_cents"]):
                raise HTTPException(502, "Invalid payment provider response")
            order["payment_intent_id"] = intent["id"]
            order["_payment"] = {"payment_intent_id": intent["id"],
                                 "client_secret": intent["client_secret"], "amount": order["amount_cents"]}
        return dict(order["_payment"])


def payment_order(obj: dict, *, succeeded: bool) -> dict:
    metadata = obj.get("metadata")
    if not isinstance(metadata, dict) or not isinstance(metadata.get("order_id"), str):
        raise HTTPException(400, "Missing order metadata")
    order = require_order(metadata["order_id"])
    if (not order.get("payment_intent_id") or obj["id"] != order["payment_intent_id"]
            or obj.get("amount") != order["amount_cents"] or obj.get("currency") != order["currency"]):
        raise HTTPException(400, "Payment does not match order")
    if succeeded and (obj.get("amount_received") != order["amount_cents"] or obj.get("status") != "succeeded"):
        raise HTTPException(400, "Payment is not fully settled")
    return order


def handle_event(event: dict) -> dict:
    event_id, kind, obj = event["id"], event["type"], event["data"]["object"]
    with state_lock:
        if event_id in processed_webhook_ids:
            return {"received": True, "deduped": True}
        if kind in {"payment_intent.succeeded", "payment_intent.payment_failed"}:
            order = payment_order(obj, succeeded=kind == "payment_intent.succeeded")
            if kind == "payment_intent.succeeded":
                order.setdefault("paid_at", event["created"])
                if order["status"] in {"pending", "payment_failed"}:
                    order["status"] = "paid"
                    order.pop("failure_code", None)
                # A refund may arrive while a receipt is pending. A later success
                # can finish that receipt without changing the refund state.
                if "paid_at" in order and not order["receipt_ids"]:
                    order["receipt_status"] = "pending"
                    try:
                        receipt = send_receipt(order)
                    except (OSError, ValueError, KeyError) as exc:
                        # Do not consume the event: Stripe redelivery retries the
                        # same payload/key, including after a lost accepted reply.
                        raise HTTPException(503, "Receipt delivery pending; retry event") from exc
                    order["receipt_ids"] = [receipt["id"]]
                    order["receipt_status"] = "sent"
            elif order["status"] in {"pending", "payment_failed"}:
                error = obj.get("last_payment_error") or {}
                if not isinstance(error, dict):
                    raise HTTPException(400, "Invalid payment error")
                order["status"] = "payment_failed"
                order["failure_code"] = error.get("code")
        elif kind == "charge.refunded":
            pi_id = obj.get("payment_intent")
            order = next((item for item in orders.values()
                          if item.get("payment_intent_id") and item["payment_intent_id"] == pi_id), None)
            if order is None:
                raise HTTPException(404, "Refund order not found")
            amount = obj.get("amount_refunded")
            if (obj.get("amount") != order["amount_cents"] or obj.get("currency") != order["currency"]
                    or type(amount) is not int or not 0 <= amount <= order["amount_cents"]):
                raise HTTPException(400, "Refund does not match order")
            order["amount_refunded"] = max(order["amount_refunded"], amount)
            if order["amount_refunded"]:
                order["status"] = ("refunded" if order["amount_refunded"] == order["amount_cents"]
                                   else "partially_refunded")
        else:
            # Unhandled events have no effects and need no dedupe storage.
            return {"received": True, "ignored": True}
        processed_webhook_ids.add(event_id)
        return {"received": True}


@app.post("/stripe-webhook")
async def stripe_webhook(request: Request, stripe_signature: str | None = Header(None)) -> dict:
    if not stripe_signature:
        raise HTTPException(400, "Missing Stripe-Signature")
    payload = await request.body()
    try:
        event = stripe.Webhook.construct_event(payload, stripe_signature, STRIPE_WEBHOOK_SECRET)
        obj = event["data"]["object"]
        if (not isinstance(event.get("id"), str) or not event["id"]
                or not isinstance(event.get("type"), str) or not event["type"]
                or type(event.get("created")) is not int or event.get("livemode") is not False
                or not isinstance(obj, dict) or not isinstance(obj.get("id"), str) or not obj["id"]
                or obj.get("livemode") is True):
            raise ValueError("Malformed or live event")
        expected = {"payment_intent.succeeded": "payment_intent",
                    "payment_intent.payment_failed": "payment_intent", "charge.refunded": "charge"}
        if event["type"] in expected and obj.get("object") != expected[event["type"]]:
            raise ValueError("Wrong resource type")
    except (ValueError, KeyError, TypeError, AttributeError, stripe.error.SignatureVerificationError) as exc:
        raise HTTPException(400, "Invalid signature or test event") from exc
    return await run_in_threadpool(handle_event, event)


@app.post("/orders/{order_id}/refund")
def refund_order(order_id: str) -> dict:
    with state_lock:
        order = require_order(order_id)
        if order["status"] == "refunded" and "_refund" in order:
            return {"refund_id": order["_refund"]["id"], "status": "succeeded"}
        if order["status"] not in {"paid", "partially_refunded", "refund_pending"}:
            raise HTTPException(400, "Only paid orders can be refunded")
        previous = order.get("_refund")
        try:
            if previous and previous["status"] in {"pending", "requires_action"}:
                refund = stripe.Refund.retrieve(previous["id"])
            else:
                # Persist the exact attempt inputs before sending. An uncertain
                # response reuses these even if a refund webhook arrives first.
                if previous and previous["status"] in {"failed", "canceled"}:
                    order.pop("_refund_attempt", None)
                    order.pop("_refund", None)  # consume known failure once
                    order["_refund_generation"] = order.get("_refund_generation", 0) + 1
                if "_refund_attempt" not in order:
                    order["_refund_attempt"] = {
                        "amount": order["amount_cents"] - order["amount_refunded"],
                        "offset": order["amount_refunded"],
                        "key": f"refund:{order_id}:{order.get('_refund_generation', 0)}:{order['amount_refunded']}",
                    }
                attempt = order["_refund_attempt"]
                refund = stripe.Refund.create(payment_intent=order["payment_intent_id"],
                                              amount=attempt["amount"], idempotency_key=attempt["key"])
        except stripe.error.StripeError as exc:
            raise HTTPException(502, "Refund provider unavailable; retry this order") from exc
        status = refund.get("status")
        if (not refund.get("id") or status not in {"pending", "requires_action", "succeeded", "failed", "canceled"}
                or type(refund.get("amount")) is not int or refund["amount"] != order["_refund_attempt"]["amount"]
                or refund.get("payment_intent") != order["payment_intent_id"]
                or refund.get("currency") != order["currency"]):
            raise HTTPException(502, "Invalid refund provider response")
        order["_refund"] = dict(refund)
        order["refund_id"], order["refund_status"] = refund["id"], status
        if status == "succeeded":
            order["amount_refunded"] = max(order["amount_refunded"],
                                           order["_refund_attempt"]["offset"] + refund["amount"])
            order["status"] = ("refunded" if order["amount_refunded"] == order["amount_cents"]
                               else "partially_refunded")
        elif status in {"pending", "requires_action"}:
            order["status"] = "refund_pending"
        else:
            order["status"] = "partially_refunded" if order["amount_refunded"] else "paid"
        return {"refund_id": refund["id"], "status": status}
