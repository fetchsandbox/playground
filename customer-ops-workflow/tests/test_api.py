"""HTTP API smoke tests (Slack URL verification + workflow start)."""

from __future__ import annotations

import os

from fastapi.testclient import TestClient

from customer_ops.api import app
from customer_ops.store import InMemoryWorkflowStore, reset_store_for_tests


def setup_function():
    reset_store_for_tests(InMemoryWorkflowStore())
    for key in (
        "FETCHSANDBOX_VERIFIER_TOKEN",
        "X_FLOW_RUN_ID",
        "SLACK_SIGNING_SECRET",
        "REQUIRE_SLACK_SIGNATURE",
        "CUSTOMER_OPS_REQUIRE_SLACK_SIG",
        "STRIPE_WEBHOOK_SECRET",
        "CUSTOMER_OPS_REQUIRE_STRIPE_SIG",
    ):
        os.environ.pop(key, None)


def test_health():
    client = TestClient(app)
    assert client.get("/health").json()["status"] == "ok"


def test_slack_url_verification():
    client = TestClient(app)
    resp = client.post("/slack/events", json={"type": "url_verification", "challenge": "abc"})
    assert resp.status_code == 200
    assert resp.json()["challenge"] == "abc"


def test_start_workflow_and_get():
    client = TestClient(app)
    resp = client.post(
        "/workflows",
        json={
            "customer_email": "ada@acme.com",
            "customer_name": "Ada",
            "company": "Acme",
            "sku": "pro_annual",
            "quantity": 2,
            "channel_id": "C01",
            "idempotency_key": "http-1",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "completed"
    assert "research" in body["agent_results"]

    got = client.get(f"/workflows/{body['workflow_id']}")
    assert got.status_code == 200
    assert got.json()["workflow_id"] == body["workflow_id"]


def test_slack_command():
    client = TestClient(app)
    resp = client.post(
        "/slack/commands",
        data={
            "text": "email=ada@acme.com company=Acme qty=1",
            "channel_id": "C01",
            "user_id": "U01",
            "team_id": "T01",
            "trigger_id": "trig-1",
        },
    )
    assert resp.status_code == 200
    assert "Started workflow" in resp.json()["text"]
