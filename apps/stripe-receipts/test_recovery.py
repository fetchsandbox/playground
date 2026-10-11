"""Local regression evidence, not a production twin receipt or Cursor persona pass."""
import concurrent.futures
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import urllib.error

import pytest
from fastapi.testclient import TestClient
import main


@pytest.fixture
def state(tmp_path, monkeypatch):
    monkeypatch.setenv("ORDERS_DB_PATH", str(tmp_path / "orders.sqlite3"))
    accepted, payments = {}, {}
    control = {"failure": None, "sends": 0}

    def retrieve(pi, **kwargs):
        if control["failure"] == "stripe_auth":
            raise main.stripe.error.AuthenticationError("Controlled auth rejection")
        return dict(payments[pi])

    def send(order):
        control["sends"] += 1
        key = "receipt/" + order["id"]
        if control["failure"] in ("auth", "429", "503", "timeout"):
            raise urllib.error.URLError("Controlled provider rejection")
        accepted.setdefault(key, {"id": "email_" + order["id"]})
        if control["failure"] == "lost_response":
            control["failure"] = None
            raise TimeoutError("Accepted, response lost")
        return accepted[key]

    monkeypatch.setattr(main.stripe.PaymentIntent, "retrieve", retrieve)
    monkeypatch.setattr(main, "send_receipt", send)
    client = TestClient(main.app, raise_server_exceptions=False)
    order = client.post("/orders", json={"sku": "mug", "quantity": 1, "customer_email": "buyer@example.test"}).json()
    payment = {"id": "pi_test", "status": "succeeded", "amount": 1000, "currency": "usd", "metadata": {"order_id": order["id"]}}
    payments["pi_test"] = payment
    with main.store.transaction() as db:
        saved = main.store.get(db, order["id"])
        saved["payment_intent_id"] = "pi_test"
        main.store.put(db, saved)
    def event(event_type="payment_intent.succeeded", event_id="evt_test", obj=None):
        body = json.dumps({"id": event_id, "type": event_type, "created": int(time.time()), "data": {"object": obj or payment}}).encode()
        timestamp = str(int(time.time()))
        signature = hmac.new(main.STRIPE_WEBHOOK_SECRET.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
        return client.post("/stripe-webhook", content=body, headers={"Stripe-Signature": f"t={timestamp},v1={signature}"})
    return client, order, payment, control, accepted, event


def test_concurrent_exact_redelivery_has_one_effect(state):
    client, order, _, control, accepted, event = state
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        statuses = list(pool.map(lambda _: event().status_code, range(6)))
    assert statuses == [200] * 6
    assert len(accepted) == control["sends"] == 1
    assert len(client.get("/orders/" + order["id"]).json()["receipt_ids"]) == 1


@pytest.mark.parametrize("failure", ["auth", "429", "503", "timeout", "lost_response"])
def test_failed_or_uncertain_send_retries_same_intent(state, failure):
    client, order, _, control, accepted, event = state
    control["failure"] = failure
    assert event().status_code == 503
    pending = client.get("/orders/" + order["id"]).json()
    assert pending["status"] == "paid" and pending["receipt_status"] == "pending"
    assert pending["receipt_ids"] == []
    assert len(accepted) == (1 if failure == "lost_response" else 0)
    control["failure"] = None
    assert event().status_code == 200
    assert event().json()["deduped"] is True
    assert len(accepted) == 1
    assert client.get("/orders/" + order["id"]).json()["receipt_status"] == "sent"


def test_missed_webhook_reconciliation_and_reordered_failure(state):
    client, order, payment, _, accepted, event = state
    assert client.get("/orders/" + order["id"]).json()["status"] == "pending"
    assert client.post("/orders/" + order["id"] + "/reconcile").status_code == 200
    stale = {**payment, "status": "requires_payment_method", "last_payment_error": {"code": "card_declined"}}
    assert event("payment_intent.payment_failed", "evt_old", stale).status_code == 200
    assert client.get("/orders/" + order["id"]).json()["status"] == "paid"
    assert len(accepted) == 1


def test_restart_reads_committed_ledger_and_dedup(state):
    client, order, _, _, accepted, event = state
    assert event().status_code == 200
    # A different interpreter reads the same disk, with no shared Python dict.
    code = "import store,json;\nwith store.transaction() as db:\n print(json.dumps({'order':store.get(db," + repr(order["id"]) + "),'events':db.execute('SELECT count(*) FROM events').fetchone()[0]}))"
    other = json.loads(subprocess.check_output([sys.executable, "-c", code], cwd=Path(__file__).parent, env=os.environ))
    assert other["order"]["receipt_ids"] and other["events"] == 1
    assert event().json()["deduped"] is True and len(accepted) == 1


def test_read_can_observe_pending_payment_while_send_is_in_flight(state, monkeypatch):
    client, order, _, _, _, event = state
    entered, release = threading.Event(), threading.Event()
    def slow_send(saved):
        entered.set()
        assert release.wait(2)
        return {"id": "email_one"}
    monkeypatch.setattr(main, "send_receipt", slow_send)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        callback = pool.submit(event)
        assert entered.wait(2)
        try:
            pending = client.get("/orders/" + order["id"]).json()
            assert pending["status"] == "paid" and pending["receipt_status"] == "pending"
            assert not callback.done()
        finally:
            release.set()
        assert callback.result().status_code == 200


def test_process_crash_after_provider_acceptance_keeps_retry_intent(state, tmp_path):
    client, order, payment, control, accepted, event = state
    # Kill a genuine app process inside the external-send/local-commit window.
    # Provider acceptance below is a controlled double, never live twin proof.
    effect = tmp_path / "external-effect.json"
    code = (
        "import main,json,os;\n"
        "def accepted_then_die(order):\n"
        " f=open(" + repr(str(effect)) + ",'w');json.dump({'key':'receipt/'+order['id'],'id':'email_survives'},f);f.flush();os.fsync(f.fileno());os._exit(41)\n"
        "main.send_receipt=accepted_then_die\n"
        "main.settle_payment(" + repr(order["id"]) + "," + repr(payment) + ",'evt_test','payment_intent.succeeded')\n"
    )
    child = subprocess.run([sys.executable, "-c", code], cwd=Path(__file__).parent, env=os.environ)
    assert child.returncode == 41
    provider = json.loads(effect.read_text())
    accepted[provider["key"]] = {"id": provider["id"]}
    pending = client.get("/orders/" + order["id"]).json()
    assert pending["status"] == "paid" and pending["receipt_ids"] == []
    assert event().status_code == 200
    assert client.get("/orders/" + order["id"]).json()["receipt_ids"] == ["email_survives"]
    assert len(accepted) == 1


@pytest.mark.parametrize("changes", [{"quantity": 0}, {"quantity": -1}, {"quantity": 101}, {"quantity": True}, {"quantity": "2"}, {"sku": "unknown"}, {"customer_email": "bad"}])
def test_boundaries_rejected_without_order_write(state, changes):
    client, _, _, _, _, _ = state
    before = client.get("/orders").json()
    assert client.post("/orders", json={"sku": "mug", "quantity": 1, "customer_email": "buyer@example.test", **changes}).status_code == 422
    assert client.get("/orders").json() == before


def test_signature_mismatch_and_amount_mismatch_do_not_send(state):
    client, order, payment, _, accepted, event = state
    assert client.post("/stripe-webhook", json={"id": "evt_bad"}).status_code == 400
    payment["amount"] = 1
    assert event().status_code == 409
    assert not accepted and client.get("/orders/" + order["id"]).json()["status"] == "pending"


def test_cleanup_archives_without_erasing_dedup(state):
    client, order, _, _, accepted, event = state
    assert event().status_code == 200
    assert client.delete("/orders/" + order["id"]).json()["ledger_retained"]
    assert client.get("/orders").json() == {"orders": []}
    assert event().json()["deduped"] and len(accepted) == 1


def test_real_send_uses_stable_provider_key(state, monkeypatch):
    # Inspect the genuine HTTP sender, not the fixture's replacement function.
    spec = importlib.util.spec_from_file_location("sender", Path(main.__file__))
    sender = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sender)
    captured = []
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self): return b'{"id":"email_accepted"}'
    def open_request(req, **kwargs):
        captured.append(req)
        return Response()
    monkeypatch.setattr(sender.urllib.request, "urlopen", open_request)
    sender.send_receipt(state[1]); sender.send_receipt(state[1])
    assert [r.get_header("Idempotency-key") for r in captured] == ["receipt/" + state[1]["id"]] * 2
    assert captured[0].data == captured[1].data
