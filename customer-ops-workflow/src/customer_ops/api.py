"""FastAPI surface: Slack Events + local workflow trigger + status API."""

from __future__ import annotations

import hashlib
import hmac
import os
import time
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field

from customer_ops.models import SlackTrigger, WorkflowRequest
from customer_ops.orchestrator import Orchestrator, parse_slack_text
from customer_ops.store import get_store

app = FastAPI(
    title="Customer Ops Multi-Agent Workflow",
    description="Slack-triggered parallel agents (research, quote, billing, handoff, survey).",
    version="0.1.0",
)


class StartBody(BaseModel):
    customer_email: str
    customer_name: str | None = None
    company: str | None = None
    sku: str = "pro_annual"
    quantity: int = 1
    notes: str | None = None
    idempotency_key: str | None = None
    channel_id: str | None = None
    user_id: str | None = None


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/workflows")
def start_workflow(body: StartBody) -> dict[str, Any]:
    slack = None
    if body.channel_id:
        slack = SlackTrigger(
            event_id=body.idempotency_key or f"http-{body.customer_email}-{body.sku}",
            channel_id=body.channel_id,
            user_id=body.user_id or "U_LOCAL",
            text=f"email={body.customer_email}",
        )
    req = WorkflowRequest(
        customer_email=body.customer_email,
        customer_name=body.customer_name,
        company=body.company,
        sku=body.sku,
        quantity=body.quantity,
        notes=body.notes,
        idempotency_key=body.idempotency_key,
        slack=slack,
    )
    record = Orchestrator().start(req)
    return _public(record)


@app.get("/workflows")
def list_workflows() -> dict[str, Any]:
    items = get_store().list_recent()
    return {"workflows": [_public(r) for r in items]}


@app.get("/workflows/{workflow_id}")
def get_workflow(workflow_id: str) -> dict[str, Any]:
    record = get_store().get(workflow_id)
    if not record:
        raise HTTPException(404, "workflow not found")
    return _public(record)


@app.post("/slack/events")
async def slack_events(
    request: Request,
    x_slack_signature: str | None = Header(default=None),
    x_slack_request_timestamp: str | None = Header(default=None),
) -> dict[str, Any]:
    raw = await request.body()
    _verify_slack(raw, x_slack_signature, x_slack_request_timestamp)

    payload = await request.json()
    if payload.get("type") == "url_verification":
        return {"challenge": payload.get("challenge")}

    # Slash command form-urlencoded is handled separately; Events API JSON here.
    event = payload.get("event") or {}
    if event.get("type") not in {"app_mention", "message"}:
        return {"ok": True, "ignored": True}
    if event.get("bot_id") or event.get("subtype") == "bot_message":
        return {"ok": True, "ignored": "bot"}

    text = event.get("text") or ""
    try:
        fields = parse_slack_text(text)
    except ValueError as exc:
        # Ack Slack; surface parse error in-thread when possible
        channel = event.get("channel")
        if channel:
            from customer_ops.integrations.slack_api import SlackClient

            SlackClient().post_message(
                channel=channel,
                text=f"Could not start workflow: {exc}",
                thread_ts=event.get("thread_ts") or event.get("ts"),
            )
        return {"ok": False, "error": str(exc)}

    trigger = SlackTrigger(
        event_id=payload.get("event_id") or event.get("client_msg_id") or event.get("ts"),
        team_id=payload.get("team_id") or "T_UNKNOWN",
        channel_id=event["channel"],
        user_id=event.get("user") or "U_UNKNOWN",
        thread_ts=event.get("thread_ts") or event.get("ts"),
        text=text,
    )
    req = WorkflowRequest(**fields, slack=trigger, idempotency_key=f"slack:{trigger.event_id}")
    record = Orchestrator().start(req)
    return {"ok": True, "workflow_id": record.workflow_id, "status": record.status.value}


@app.post("/slack/commands")
async def slack_commands(request: Request) -> dict[str, Any]:
    """Slash command `/customer-ops` — returns in-channel ack; runs workflow inline for local."""
    form = dict(await request.form())
    text = str(form.get("text") or "")
    try:
        fields = parse_slack_text(text)
    except ValueError as exc:
        return {"response_type": "ephemeral", "text": str(exc)}

    trigger = SlackTrigger(
        event_id=str(form.get("trigger_id") or form.get("payment_id") or time.time()),
        team_id=str(form.get("team_id") or "T_LOCAL"),
        channel_id=str(form.get("channel_id")),
        user_id=str(form.get("user_id")),
        thread_ts=None,
        text=text,
        response_url=str(form.get("response_url") or None),
    )
    req = WorkflowRequest(**fields, slack=trigger)
    record = Orchestrator().start(req)
    return {
        "response_type": "in_channel",
        "text": (
            f"Started workflow `{record.workflow_id}` → *{record.status.value}*\n"
            f"Customer `{record.request.customer_email}` · sku `{record.request.sku}`"
        ),
    }


def _public(record) -> dict[str, Any]:
    return {
        "workflow_id": record.workflow_id,
        "status": record.status.value,
        "idempotency_key": record.idempotency_key,
        "request": record.request.model_dump(mode="json"),
        "agent_results": {
            k: v.model_dump(mode="json") for k, v in record.agent_results.items()
        },
        "summary": record.summary,
        "errors": [e.model_dump() for e in record.errors],
        "created_at": record.created_at.isoformat(),
        "updated_at": record.updated_at.isoformat(),
    }


def _verify_slack(body: bytes, signature: str | None, timestamp: str | None) -> None:
    secret = os.environ.get("SLACK_SIGNING_SECRET")
    if not secret:
        # Local/dev: skip verification unless enforced
        if os.environ.get("CUSTOMER_OPS_REQUIRE_SLACK_SIG") == "1":
            raise HTTPException(401, "SLACK_SIGNING_SECRET not configured")
        return
    if not signature or not timestamp:
        raise HTTPException(401, "missing Slack signature headers")
    if abs(time.time() - int(timestamp)) > 60 * 5:
        raise HTTPException(401, "stale Slack request")
    basestring = b"v0:" + timestamp.encode() + b":" + body
    digest = "v0=" + hmac.new(secret.encode(), basestring, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(digest, signature):
        raise HTTPException(401, "invalid Slack signature")
