"""FetchSandbox observation + webhook signature gates."""

from __future__ import annotations

import os

from fastapi.testclient import TestClient

from customer_ops import observe
from customer_ops.api import app
from customer_ops.store import InMemoryWorkflowStore, reset_store_for_tests


def setup_function():
    reset_store_for_tests(InMemoryWorkflowStore())
    observe.reset()
    os.environ.pop("FETCHSANDBOX_VERIFIER_TOKEN", None)


def test_process_workflow_case_scoped_observe():
    client = TestClient(app)
    resp = client.post(
        "/process-workflow",
        json={
            "customer_email": "ada@example.test",
            "quantity": 1,
            "run_id": "runA",
            "case_id": "baseline",
            "channel": "C0OPS01",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["result"]["billingOk"] is True
    got = client.get("/runs/runA/cases/baseline/workflows")
    assert got.status_code == 200
    assert len(got.json()["workflows"]) == 1
    assert got.json()["workflows"][0]["stripeOk"] is True


def test_duplicate_process_does_not_double_observe():
    client = TestClient(app)
    body = {
        "customer_email": "ada@example.test",
        "run_id": "runB",
        "case_id": "dup",
        "idempotency_key": "fixed-dup-key",
        "channel": "C0OPS01",
    }
    assert client.post("/process-workflow", json=body).status_code == 200
    assert client.post("/process-workflow", json=body).status_code == 200
    got = client.get("/runs/runB/cases/dup/workflows")
    assert len(got.json()["workflows"]) == 1


def test_unsigned_slack_webhook_rejected():
    os.environ["REQUIRE_SLACK_SIGNATURE"] = "1"
    os.environ["SLACK_SIGNING_SECRET"] = "test_signing_secret"
    client = TestClient(app)
    resp = client.post(
        "/webhooks/slack",
        json={
            "type": "event_callback",
            "event_id": "ev1",
            "run_id": "runC",
            "case_id": "unsigned",
            "event": {"type": "message", "text": "hi", "channel": "C0"},
        },
    )
    assert resp.status_code == 400
    assert client.get("/runs/runC/cases/unsigned/webhooks").json()["webhooks"] == []


def test_unsigned_stripe_webhook_rejected_with_secret():
    os.environ["STRIPE_WEBHOOK_SECRET"] = "whsec_test"
    os.environ["CUSTOMER_OPS_REQUIRE_STRIPE_SIG"] = "1"
    client = TestClient(app)
    resp = client.post(
        "/webhooks/stripe",
        json={
            "id": "evt_1",
            "type": "payment_intent.succeeded",
            "case_id": "stripe_unsigned",
            "data": {"object": {"id": "pi_1", "object": "payment_intent"}},
        },
    )
    assert resp.status_code == 400
