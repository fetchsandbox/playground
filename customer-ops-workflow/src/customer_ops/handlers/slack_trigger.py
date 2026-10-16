"""AWS Lambda: Slack Events/Commands → Start Step Functions execution."""

from __future__ import annotations

import json
import os
import urllib.parse
from typing import Any

import boto3

from customer_ops.models import SlackTrigger, WorkflowRequest
from customer_ops.orchestrator import parse_slack_text
from customer_ops.store import ClaimConflict, get_store
from customer_ops.models import WorkflowRecord


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    """API Gateway proxy integration entrypoint."""
    body_raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        import base64

        body_raw = base64.b64decode(body_raw).decode()

    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    content_type = headers.get("content-type", "")

    if "application/x-www-form-urlencoded" in content_type:
        form = dict(urllib.parse.parse_qsl(body_raw))
        return _handle_slash(form)

    payload = json.loads(body_raw or "{}")
    if payload.get("type") == "url_verification":
        return _resp(200, {"challenge": payload.get("challenge")})

    return _handle_event(payload)


def _handle_slash(form: dict[str, str]) -> dict[str, Any]:
    try:
        fields = parse_slack_text(form.get("text") or "")
    except ValueError as exc:
        return _resp(200, {"response_type": "ephemeral", "text": str(exc)})

    trigger = SlackTrigger(
        event_id=form.get("trigger_id") or form.get("payment_id") or form.get("token", "slash"),
        team_id=form.get("team_id", "T"),
        channel_id=form["channel_id"],
        user_id=form["user_id"],
        text=form.get("text") or "",
        response_url=form.get("response_url"),
    )
    req = WorkflowRequest(**fields, slack=trigger)
    execution_arn = _start_or_claim(req)
    return _resp(
        200,
        {
            "response_type": "in_channel",
            "text": f"Queued customer-ops workflow (execution `{execution_arn.split(':')[-1]}`)",
        },
    )


def _handle_event(payload: dict[str, Any]) -> dict[str, Any]:
    event = payload.get("event") or {}
    if event.get("bot_id"):
        return _resp(200, {"ok": True})
    try:
        fields = parse_slack_text(event.get("text") or "")
    except ValueError:
        return _resp(200, {"ok": False, "error": "parse"})

    trigger = SlackTrigger(
        event_id=payload.get("event_id") or event.get("ts"),
        team_id=payload.get("team_id", "T"),
        channel_id=event["channel"],
        user_id=event.get("user", "U"),
        thread_ts=event.get("thread_ts") or event.get("ts"),
        text=event.get("text") or "",
    )
    req = WorkflowRequest(**fields, slack=trigger, idempotency_key=f"slack:{trigger.event_id}")
    _start_or_claim(req)
    return _resp(200, {"ok": True})


def _start_or_claim(req: WorkflowRequest) -> str:
    """Claim idempotency row first, then start SFN (or return existing)."""
    store = get_store()
    record = WorkflowRecord(request=req, idempotency_key=req.resolve_idempotency_key())
    try:
        claimed = store.claim(record, lease_owner="slack-trigger")
    except ClaimConflict as conflict:
        return conflict.existing.summary.get("execution_arn") or conflict.existing.workflow_id

    sm_arn = os.environ["STATE_MACHINE_ARN"]
    sfn = boto3.client("stepfunctions")
    resp = sfn.start_execution(
        stateMachineArn=sm_arn,
        name=claimed.workflow_id,
        input=json.dumps(
            {
                "workflow_id": claimed.workflow_id,
                "request": req.model_dump(mode="json"),
                "idempotency_key": claimed.idempotency_key,
            }
        ),
    )
    claimed.summary["execution_arn"] = resp["executionArn"]
    store.save(claimed)
    return resp["executionArn"]


def _resp(status: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }
