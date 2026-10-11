"""The saved pre-fix app must actually exhibit the failures under test."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
import importlib.util
import json
from pathlib import Path
import threading
import time

from fastapi.testclient import TestClient
from starlette.requests import Request


def load_before():
    spec = importlib.util.spec_from_file_location("before", Path(__file__).parent / "fixtures/before_messy_suite.py")
    before = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(before)
    return before


def order_and_event(before):
    order = before.create_order(before.CreateOrderReq(sku="mug", quantity=1, customer_email="buyer@example.test"))
    payment = {"id": "pi_original", "metadata": {"order_id": order["id"]}}
    return order, {"id": "evt_original", "type": "payment_intent.succeeded", "created": int(time.time()), "data": {"object": payment}}


def call_event(before, event):
    body = json.dumps(event).encode()
    timestamp = str(int(time.time()))
    signature = hmac.new(before.STRIPE_WEBHOOK_SECRET.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
    async def receive(): return {"type": "http.request", "body": body, "more_body": False}
    request = Request({"type": "http", "method": "POST", "path": "/stripe-webhook", "headers": []}, receive)
    return asyncio.run(before.stripe_webhook(request, f"t={timestamp},v1={signature}"))


def test_original_concurrent_first_delivery_sends_two_receipts():
    before = load_before()
    order, event = order_and_event(before)
    barrier = threading.Barrier(2)
    effects = []
    def send(order):
        barrier.wait(timeout=2)
        effects.append("email_" + str(len(effects)))
        return {"id": effects[-1]}
    before.send_receipt = send
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: call_event(before, event), range(2)))
    assert all(r["received"] for r in results)
    assert len(effects) == len(order["receipt_ids"]) == 2


def test_original_lost_response_creates_a_second_email():
    before = load_before()
    order, event = order_and_event(before)
    effects = []
    def send(order):
        effects.append("email_" + str(len(effects)))
        if len(effects) == 1: raise TimeoutError("Provider accepted but response lost")
        return {"id": effects[-1]}
    before.send_receipt = send
    try: call_event(before, event)
    except TimeoutError: pass
    assert call_event(before, event)["received"]
    assert len(effects) == 2 and len(order["receipt_ids"]) == 1


def test_original_stale_failure_overwrites_a_paid_order():
    before = load_before()
    order, event = order_and_event(before)
    before.send_receipt = lambda order: {"id": "email_one"}
    call_event(before, event)
    assert order["status"] == "paid"
    call_event(before, {**event, "id": "evt_older_failure", "type": "payment_intent.payment_failed"})
    assert order["status"] == "payment_failed"


def test_original_accepts_invalid_quantity_and_loses_state_on_new_instance():
    before = load_before()
    client = TestClient(before.app)
    assert client.post("/orders", json={"sku": "anything", "quantity": -1, "customer_email": "bad"}).status_code == 200
    assert len(before.orders) == 1
    assert load_before().orders == {}
