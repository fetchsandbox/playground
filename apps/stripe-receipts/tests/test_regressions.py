"""Supplementary application regressions; these are NOT FetchSandbox proof.

The real FastAPI routes and Stripe signature verifier run in-process. Every
provider boundary is replaced with a deterministic fake; loopback-only URLs
provide an additional fail-closed safeguard against accidental external calls.
"""
from __future__ import annotations

import hashlib
import hmac
import io
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ.update(
    STRIPE_API_KEY="sk_test_local_regressions",
    STRIPE_WEBHOOK_SECRET="whsec_local_regressions",
    STRIPE_API_BASE="http://127.0.0.1:1",
    RESEND_API_KEY="re_local_regressions",
    RESEND_API_BASE="http://127.0.0.1:1",
    RESEND_FROM="receipts@example.test",
)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main  # noqa: E402


class Providers:
    """Model provider idempotency, including accepted-but-lost email replies."""

    def __init__(self):
        self.lock = threading.Lock()
        self.intents = {}
        self.intent_keys = {}
        self.intent_requests = []
        self.refunds = {}
        self.refund_keys = {}
        self.refund_requests = []
        self.refund_status = "succeeded"
        self.email_requests = []
        self.email_deliveries = {}
        self.email_mode = "ok"

    def create_intent(self, **kwargs):
        # Allow concurrent route calls to overlap outside the provider lock.
        time.sleep(0.01)
        with self.lock:
            self.intent_requests.append(kwargs)
            key = kwargs.get("idempotency_key")
            if key and key in self.intent_keys:
                return dict(self.intents[self.intent_keys[key]])
            intent_id = f"pi_local_{len(self.intents) + 1}"
            intent = dict(
                id=intent_id, object="payment_intent", livemode=False,
                client_secret=f"{intent_id}_secret_local", status="requires_payment_method",
                amount=kwargs["amount"], amount_received=0,
                currency=kwargs["currency"], metadata=kwargs["metadata"],
            )
            self.intents[intent_id] = intent
            if key:
                self.intent_keys[key] = intent_id
            return dict(intent)

    def retrieve_intent(self, intent_id, **kwargs):
        return dict(self.intents[intent_id])

    def create_refund(self, **kwargs):
        with self.lock:
            self.refund_requests.append(kwargs)
            key = kwargs.get("idempotency_key")
            if key and key in self.refund_keys:
                return dict(self.refunds[self.refund_keys[key]])
            intent = self.intents[kwargs["payment_intent"]]
            refund_id = f"re_local_{len(self.refunds) + 1}"
            refund = dict(
                id=refund_id, object="refund", status=self.refund_status,
                payment_intent=intent["id"], amount=kwargs.get("amount", intent["amount"]),
                currency=intent["currency"], metadata=kwargs.get("metadata", {}),
            )
            self.refunds[refund_id] = refund
            if key:
                self.refund_keys[key] = refund_id
            return dict(refund)

    def retrieve_refund(self, refund_id, **kwargs):
        return dict(self.refunds[refund_id])

    def urlopen(self, request, **kwargs):
        assert request.full_url == "http://127.0.0.1:1/emails"
        headers = {key.lower(): value for key, value in request.header_items()}
        body = json.loads(request.data)
        assert all(address.endswith("@example.test") for address in body["to"])
        self.email_requests.append({"headers": headers, "body": body})
        first = len(self.email_requests) == 1
        if self.email_mode == "reject_first" and first:
            raise urllib.error.HTTPError(request.full_url, 503, "temporary failure", {}, None)
        key = headers.get("idempotency-key") or f"unkeyed-{len(self.email_requests)}"
        receipt = self.email_deliveries.setdefault(key, {"id": f"email_{len(self.email_deliveries) + 1}"})
        if self.email_mode == "lose_first_response" and first:
            raise TimeoutError("accepted by provider; response lost")
        return io.StringIO(json.dumps(receipt))


@pytest.fixture
def service(monkeypatch):
    main.orders.clear()
    for name in ("processed_webhook_ids", "processed_event_ids"):
        state = getattr(main, name, None)
        if state is not None:
            state.clear()
    monkeypatch.setattr(main, "STRIPE_WEBHOOK_SECRET", "whsec_local_regressions")
    monkeypatch.setattr(main, "RESEND_API_BASE", "http://127.0.0.1:1")
    providers = Providers()
    monkeypatch.setattr(main.stripe.PaymentIntent, "create", providers.create_intent)
    monkeypatch.setattr(main.stripe.PaymentIntent, "retrieve", providers.retrieve_intent)
    monkeypatch.setattr(main.stripe.Refund, "create", providers.create_refund)
    monkeypatch.setattr(main.stripe.Refund, "retrieve", providers.retrieve_refund)
    monkeypatch.setattr(main.urllib.request, "urlopen", providers.urlopen)
    with TestClient(main.app, raise_server_exceptions=False) as client:
        yield client, providers


def order_and_intent(service):
    client, providers = service
    response = client.post("/orders", json={"sku": "qa-widget", "quantity": 1,
                                            "customer_email": "qa@example.test"})
    assert response.status_code == 200, response.text
    order = response.json()
    payment = client.post(f"/orders/{order['id']}/pay")
    assert payment.status_code == 200, payment.text
    return order, providers.intents[payment.json()["payment_intent_id"]]


def event_for(order, intent, event_id="evt_local_success", event_type="payment_intent.succeeded", **updates):
    obj = dict(intent)
    obj.update(status="succeeded", amount_received=order["amount_cents"])
    obj.update(updates)
    return {"id": event_id, "object": "event", "type": event_type,
            "created": int(time.time()), "livemode": False, "data": {"object": obj}}


def deliver(client, event, delivery_header=None, timestamp=None, signature=None, omit_signature=False):
    raw = json.dumps(event, separators=(",", ":")).encode()
    timestamp = int(time.time()) if timestamp is None else timestamp
    digest = hmac.new(b"whsec_local_regressions", str(timestamp).encode() + b"." + raw,
                      hashlib.sha256).hexdigest()
    headers = {"Content-Type": "application/json"}
    if not omit_signature:
        headers["Stripe-Signature"] = signature or f"t={timestamp},v1={digest}"
    if delivery_header is not None:
        headers["stripe-webhook-id"] = delivery_header
    return client.post("/stripe-webhook", content=raw, headers=headers)


def detail(client, order):
    response = client.get(f"/orders/{order['id']}")
    assert response.status_code == 200
    return response.json()


def mark_paid(service, order, intent):
    response = deliver(service[0], event_for(order, intent), "delivery_success")
    assert response.status_code == 200, response.text
    assert detail(service[0], order)["status"] == "paid"


def test_happy_path_paid_receipt_and_refund(service):
    client, providers = service
    order, intent = order_and_intent(service)
    mark_paid(service, order, intent)
    assert len(providers.email_deliveries) == 1
    assert len(detail(client, order).get("receipt_ids", [])) == 1
    refund = client.post(f"/orders/{order['id']}/refund")
    assert refund.status_code == 200, refund.text
    assert detail(client, order)["status"] == "refunded"


def test_distinct_headerless_events_both_process(service):
    client, providers = service
    first, pi1 = order_and_intent(service)
    second, pi2 = order_and_intent(service)
    assert deliver(client, event_for(first, pi1, "evt_one")).status_code == 200
    assert deliver(client, event_for(second, pi2, "evt_two")).status_code == 200
    assert [detail(client, order)["status"] for order in (first, second)] == ["paid", "paid"]
    assert len(providers.email_deliveries) == 2


def test_event_id_dedupes_changed_delivery_headers(service):
    client, providers = service
    order, intent = order_and_intent(service)
    event = event_for(order, intent)
    assert deliver(client, event, "delivery_1").status_code == 200
    assert deliver(client, event, "delivery_2").status_code == 200
    assert len(providers.email_deliveries) == 1
    assert len(detail(client, order).get("receipt_ids", [])) == 1


@pytest.mark.parametrize("mode", ["reject_first", "lose_first_response"])
def test_receipt_retry_recovers_without_duplicate_delivery(service, mode):
    client, providers = service
    order, intent = order_and_intent(service)
    providers.email_mode = mode
    event = event_for(order, intent)
    first = deliver(client, event, "same_delivery")
    assert first.status_code >= 500, "A receipt failure must remain retryable by Stripe"
    retry = deliver(client, event, "same_delivery")
    assert retry.status_code == 200, retry.text
    assert len(providers.email_requests) == 2, "The failed receipt must actually be retried"
    assert len(providers.email_deliveries) == 1
    assert len(detail(client, order).get("receipt_ids", [])) == 1
    if mode == "lose_first_response":
        keys = [request["headers"].get("idempotency-key") for request in providers.email_requests]
        assert keys[0] and keys[0] == keys[1], "Retries need one stable Resend idempotency key"


def test_distinct_success_events_for_same_payment_send_one_receipt(service):
    client, providers = service
    order, intent = order_and_intent(service)
    assert deliver(client, event_for(order, intent, "evt_a"), "delivery_a").status_code == 200
    assert deliver(client, event_for(order, intent, "evt_b"), "delivery_b").status_code == 200
    assert len(providers.email_deliveries) == 1
    assert len(detail(client, order).get("receipt_ids", [])) == 1


def test_repeated_pay_uses_one_intent(service):
    client, providers = service
    order, intent = order_and_intent(service)
    retry = client.post(f"/orders/{order['id']}/pay")
    assert retry.status_code == 200, retry.text
    assert retry.json()["payment_intent_id"] == intent["id"]
    assert len(providers.intents) == 1


def test_concurrent_pay_uses_one_intent(service):
    client, providers = service
    response = client.post("/orders", json={"sku": "qa-widget", "quantity": 1,
                                            "customer_email": "qa@example.test"})
    order = response.json()
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda _: client.post(f"/orders/{order['id']}/pay"), range(4)))
    assert all(response.status_code == 200 for response in responses)
    assert len({response.json()["payment_intent_id"] for response in responses}) == 1
    assert len(providers.intents) == 1


@pytest.mark.parametrize("updates", [{"id": "pi_other"}, {"amount": 999},
                                        {"amount_received": 999}, {"currency": "eur"}])
def test_mismatched_payment_event_cannot_mark_paid(service, updates):
    client, providers = service
    order, intent = order_and_intent(service)
    before = detail(client, order)["status"]
    response = deliver(client, event_for(order, intent, **updates), "delivery_invalid")
    assert response.status_code < 500, response.text
    assert detail(client, order)["status"] == before
    assert not providers.email_requests


def test_late_failure_cannot_regress_paid(service):
    client, providers = service
    order, intent = order_and_intent(service)
    mark_paid(service, order, intent)
    failure = event_for(order, intent, "evt_late_failure", "payment_intent.payment_failed",
                        status="requires_payment_method", last_payment_error={"code": "card_declined"})
    assert deliver(client, failure, "delivery_failure").status_code == 200
    assert detail(client, order)["status"] == "paid"
    assert len(providers.email_deliveries) == 1


def test_late_success_cannot_regress_refunded(service):
    client, providers = service
    order, intent = order_and_intent(service)
    mark_paid(service, order, intent)
    assert client.post(f"/orders/{order['id']}/refund").status_code == 200
    assert deliver(client, event_for(order, intent, "evt_late_success"), "delivery_late").status_code == 200
    assert detail(client, order)["status"] == "refunded"
    assert len(providers.email_deliveries) == 1


def test_failed_payment_can_be_retried(service):
    client, providers = service
    order, intent = order_and_intent(service)
    failure = event_for(order, intent, "evt_failure", "payment_intent.payment_failed",
                        status="requires_payment_method", last_payment_error={"code": "card_declined"})
    assert deliver(client, failure, "delivery_failure").status_code == 200
    response = client.post(f"/orders/{order['id']}/pay")
    assert response.status_code == 200, response.text
    assert response.json()["payment_intent_id"] == intent["id"]
    assert len(providers.intents) == 1


@pytest.mark.parametrize("status", ["pending", "failed", "canceled"])
def test_unsuccessful_refund_does_not_mark_refunded(service, status):
    client, providers = service
    order, intent = order_and_intent(service)
    mark_paid(service, order, intent)
    providers.refund_status = status
    response = client.post(f"/orders/{order['id']}/refund")
    assert response.status_code < 500, response.text
    assert detail(client, order)["status"] != "refunded"


@pytest.mark.parametrize("amount_refunded,expected_full", [(500, False), (1000, True)])
def test_refund_webhook_distinguishes_partial_and_full(service, amount_refunded, expected_full):
    client, _ = service
    order, intent = order_and_intent(service)
    mark_paid(service, order, intent)
    event = {"id": "evt_refund", "object": "event", "type": "charge.refunded",
             "created": int(time.time()), "livemode": False,
             "data": {"object": {"id": "ch_local", "object": "charge", "payment_intent": intent["id"],
                                  "amount": 1000, "amount_refunded": amount_refunded,
                                  "currency": "usd", "refunded": expected_full}}}
    assert deliver(client, event, "delivery_refund").status_code == 200
    assert (detail(client, order)["status"] == "refunded") == expected_full


@pytest.mark.parametrize("updates", [{"quantity": 0}, {"quantity": -1}, {"quantity": True},
                                        {"sku": ""}, {"sku": "   "},
                                        {"customer_email": "invalid"}, {"customer_email": ""}])
def test_invalid_order_input_rejected(service, updates):
    client, providers = service
    body = {"sku": "qa-widget", "quantity": 1, "customer_email": "qa@example.test"}
    body.update(updates)
    response = client.post("/orders", json=body)
    assert response.status_code in (400, 422), response.text
    assert not providers.intent_requests and not providers.email_requests


@pytest.mark.parametrize("signature_case", ["missing", "invalid", "stale"])
def test_invalid_signatures_rejected_without_side_effects(service, signature_case):
    client, providers = service
    order, intent = order_and_intent(service)
    options = {"missing": {"omit_signature": True},
               "invalid": {"signature": "t=123,v1=not-a-signature"},
               "stale": {"timestamp": int(time.time()) - 1000}}[signature_case]
    before = detail(client, order)
    response = deliver(client, event_for(order, intent), **options)
    assert response.status_code == 400, response.text
    assert detail(client, order) == before
    assert not providers.email_requests


@pytest.mark.parametrize("distinct_event_ids", [False, True])
def test_extra_concurrent_webhooks_send_one_receipt(service, distinct_event_ids):
    client, providers = service
    order, intent = order_and_intent(service)

    def post_event(index):
        event_id = f"evt_concurrent_{index}" if distinct_event_ids else "evt_concurrent_same"
        return deliver(client, event_for(order, intent, event_id), f"delivery_concurrent_{index}")

    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(post_event, range(4)))
    assert all(response.status_code == 200 for response in responses)
    assert len(providers.email_deliveries) == 1
    assert len(detail(client, order).get("receipt_ids", [])) == 1


def test_extra_stripe_create_error_is_controlled_and_retryable(service, monkeypatch):
    client, providers = service
    response = client.post("/orders", json={"sku": "qa-widget", "quantity": 1,
                                            "customer_email": "qa@example.test"})
    order = response.json()

    def fail_create(**kwargs):
        raise main.stripe.error.APIConnectionError("synthetic Stripe connection failure")

    monkeypatch.setattr(main.stripe.PaymentIntent, "create", fail_create)
    failed = client.post(f"/orders/{order['id']}/pay")
    assert failed.status_code in (502, 503), failed.text
    assert detail(client, order)["status"] == "pending"
    monkeypatch.setattr(main.stripe.PaymentIntent, "create", providers.create_intent)
    assert client.post(f"/orders/{order['id']}/pay").status_code == 200
    assert len(providers.intents) == 1


def test_extra_stripe_refund_error_is_controlled_and_retryable(service, monkeypatch):
    client, providers = service
    order, intent = order_and_intent(service)
    mark_paid(service, order, intent)

    def fail_refund(**kwargs):
        raise main.stripe.error.APIConnectionError("synthetic Stripe connection failure")

    monkeypatch.setattr(main.stripe.Refund, "create", fail_refund)
    failed = client.post(f"/orders/{order['id']}/refund")
    assert failed.status_code in (502, 503), failed.text
    assert detail(client, order)["status"] != "refunded"
    monkeypatch.setattr(main.stripe.Refund, "create", providers.create_refund)
    assert client.post(f"/orders/{order['id']}/refund").status_code == 200
    assert detail(client, order)["status"] == "refunded"
    assert len(providers.refunds) == 1


@pytest.mark.parametrize("operation", ["pay", "refund"])
def test_extra_lost_stripe_response_reuses_idempotency_key(service, monkeypatch, operation):
    client, providers = service
    if operation == "refund":
        order, intent = order_and_intent(service)
        mark_paid(service, order, intent)
        boundary = main.stripe.Refund
        real_fake = providers.create_refund
        requests = providers.refund_requests
        provider_objects = providers.refunds
    else:
        response = client.post("/orders", json={"sku": "qa-widget", "quantity": 1,
                                                "customer_email": "qa@example.test"})
        order = response.json()
        boundary = main.stripe.PaymentIntent
        real_fake = providers.create_intent
        requests = providers.intent_requests
        provider_objects = providers.intents
    first = True

    def accept_then_lose_response(**kwargs):
        nonlocal first
        response = real_fake(**kwargs)
        if first:
            first = False
            raise main.stripe.error.APIConnectionError("provider accepted; synthetic response loss")
        return response

    monkeypatch.setattr(boundary, "create", accept_then_lose_response)
    failed = client.post(f"/orders/{order['id']}/{operation}")
    retry = client.post(f"/orders/{order['id']}/{operation}")
    assert retry.status_code == 200, retry.text
    assert len(requests) == 2
    assert len(provider_objects) == 1
    keys = [request.get("idempotency_key") for request in requests]
    assert keys[0] and keys[0] == keys[1]
    assert failed.status_code in (502, 503), failed.text


def test_extra_repeated_successful_refund_has_one_effect(service):
    client, providers = service
    order, intent = order_and_intent(service)
    mark_paid(service, order, intent)
    first = client.post(f"/orders/{order['id']}/refund")
    assert first.status_code == 200
    second = client.post(f"/orders/{order['id']}/refund")
    assert second.status_code in (200, 400, 409), second.text
    if second.status_code == 200:
        assert second.json()["refund_id"] == first.json()["refund_id"]
    assert detail(client, order)["status"] == "refunded"
    assert len(providers.refunds) == 1


@pytest.mark.parametrize("malformation", ["live_event", "missing_event_id", "missing_event_type",
                                          "missing_data", "null_resource", "string_resource",
                                          "missing_resource_id", "wrong_resource_type"])
def test_extra_signed_malformed_event_rejected_without_500(service, malformation):
    client, providers = service
    order, intent = order_and_intent(service)
    event = event_for(order, intent)
    if malformation == "live_event":
        event["livemode"] = True
        event["data"]["object"]["livemode"] = True
    elif malformation == "missing_event_id":
        del event["id"]
    elif malformation == "missing_event_type":
        del event["type"]
    elif malformation == "missing_data":
        del event["data"]
    elif malformation == "null_resource":
        event["data"]["object"] = None
    elif malformation == "string_resource":
        event["data"]["object"] = "pi_local_1"
    elif malformation == "missing_resource_id":
        del event["data"]["object"]["id"]
    elif malformation == "wrong_resource_type":
        event["data"]["object"]["object"] = "customer"
    before = detail(client, order)
    response = deliver(client, event, "delivery_malformed")
    assert 400 <= response.status_code < 500, response.text
    assert detail(client, order) == before
    assert not providers.email_requests


# New safety policy checks are deliberately excluded from the original-code
# baseline command (-k extra); they are checked once guardrails are implemented.
@pytest.mark.parametrize("setting,value", [("STRIPE_API_BASE", "https://api.stripe.com"),
                                            ("RESEND_API_BASE", "https://api.resend.com")])
def test_safety_public_provider_endpoint_rejected_at_startup(setting, value):
    environment = dict(os.environ)
    environment[setting] = value
    process = subprocess.run([sys.executable, "-c", "import main"],
                             cwd=Path(__file__).resolve().parents[1], env=environment,
                             capture_output=True, text=True, timeout=10)
    assert process.returncode != 0, f"Startup permitted the public provider endpoint for {setting}"


def test_safety_non_test_recipient_rejected(service):
    client, providers = service
    response = client.post("/orders", json={"sku": "qa-widget", "quantity": 1,
                                            "customer_email": "qa@example.com"})
    assert response.status_code in (400, 422), response.text
    assert not providers.intent_requests and not providers.email_requests


def test_postpatch_failed_refund_next_attempt_preserves_lost_response_key(service, monkeypatch):
    """A known failure allows a new attempt, whose uncertain reply must not.

    Added during candidate review; not included in either original-code baseline.
    """
    client, providers = service
    order, intent = order_and_intent(service)
    mark_paid(service, order, intent)
    providers.refund_status = "failed"
    failed_refund = client.post(f"/orders/{order['id']}/refund")
    assert failed_refund.status_code == 200
    assert failed_refund.json()["status"] == "failed"
    providers.refund_status = "succeeded"
    first_new_attempt = True

    def accept_then_lose_new_attempt(**kwargs):
        nonlocal first_new_attempt
        response = providers.create_refund(**kwargs)
        if first_new_attempt:
            first_new_attempt = False
            raise main.stripe.error.APIConnectionError("new refund accepted; response lost")
        return response

    monkeypatch.setattr(main.stripe.Refund, "create", accept_then_lose_new_attempt)
    uncertain = client.post(f"/orders/{order['id']}/refund")
    assert uncertain.status_code in (502, 503)
    retry = client.post(f"/orders/{order['id']}/refund")
    assert retry.status_code == 200, retry.text
    assert detail(client, order)["status"] == "refunded"
    assert len(providers.refunds) == 2, "One failed attempt and one successful attempt"
    keys = [request.get("idempotency_key") for request in providers.refund_requests]
    assert len(keys) == 3 and keys[0] != keys[1] and keys[1] == keys[2]


def test_postpatch_refund_before_first_success_preserves_receipt_and_terminal_state(service):
    client, providers = service
    order, intent = order_and_intent(service)
    refund = {"id": "evt_refund_first", "object": "event", "type": "charge.refunded",
              "created": int(time.time()), "livemode": False,
              "data": {"object": {"id": "ch_refund_first", "object": "charge",
                                   "payment_intent": intent["id"], "amount": 1000,
                                   "amount_refunded": 1000, "currency": "usd", "refunded": True}}}
    assert deliver(client, refund, "delivery_refund_first").status_code == 200
    assert detail(client, order)["status"] == "refunded"
    assert not providers.email_requests
    for event_id in ("evt_success_late", "evt_success_late_again"):
        success = event_for(order, intent, event_id)
        assert deliver(client, success, f"delivery_{event_id}").status_code == 200
    result = detail(client, order)
    assert result["status"] == "refunded"
    assert isinstance(result["paid_at"], int)
    assert len(providers.email_deliveries) == 1
    assert len(result["receipt_ids"]) == 1


@pytest.mark.parametrize("local", [".qa", "qa.", "qa..test", "a" * 65])
def test_postpatch_invalid_email_local_rejected(service, local):
    client, providers = service
    response = client.post("/orders", json={"sku": "qa-widget", "quantity": 1,
                                            "customer_email": f"{local}@example.test"})
    assert response.status_code in (400, 422), response.text
    assert not providers.intent_requests and not providers.email_requests


@pytest.mark.parametrize("provider_amount,accepted", [(1000, True), ("1000", False), ("999", False),
                                                      ("1000.0", False), (1000.0, False),
                                                      ("01000", False), (True, False)])
def test_postpatch_payment_response_requires_integer_amount(service, monkeypatch, provider_amount, accepted):
    client, providers = service
    response = client.post("/orders", json={"sku": "qa-widget", "quantity": 1,
                                            "customer_email": "qa@example.test"})
    order = response.json()

    def create_with_amount(**kwargs):
        intent = providers.create_intent(**kwargs)
        intent["amount"] = provider_amount
        return intent

    monkeypatch.setattr(main.stripe.PaymentIntent, "create", create_with_amount)
    payment = client.post(f"/orders/{order['id']}/pay")
    if accepted:
        assert payment.status_code == 200, payment.text
        assert type(payment.json()["amount"]) is int
        assert payment.json()["amount"] == order["amount_cents"]
        assert detail(client, order)["payment_intent_id"] == payment.json()["payment_intent_id"]
    else:
        assert payment.status_code == 502, payment.text
        assert detail(client, order)["status"] == "pending"
        assert "payment_intent_id" not in detail(client, order)
        monkeypatch.setattr(main.stripe.PaymentIntent, "create", providers.create_intent)
        retry = client.post(f"/orders/{order['id']}/pay")
        assert retry.status_code == 200, retry.text
        assert len(providers.intents) == 1


@pytest.mark.parametrize("amount_field", ["amount", "amount_received"])
def test_postpatch_webhook_amount_strings_remain_rejected(service, amount_field):
    client, providers = service
    order, intent = order_and_intent(service)
    event = event_for(order, intent, **{amount_field: "1000"})
    response = deliver(client, event, "delivery_string_amount")
    assert response.status_code == 400, response.text
    assert detail(client, order)["status"] == "pending"
    assert not providers.email_requests
