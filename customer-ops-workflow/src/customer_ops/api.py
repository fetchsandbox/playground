"""FastAPI surface: Slack/Stripe webhooks + workflow trigger + FetchSandbox observe API."""

from __future__ import annotations

import hashlib
import hmac
import os
import time
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field

from customer_ops import observe
from customer_ops.models import SlackTrigger, WorkflowRequest
from customer_ops.orchestrator import Orchestrator, parse_slack_text
from customer_ops.store import get_store, reset_store_for_tests

app = FastAPI(
    title="Customer Ops Multi-Agent Workflow",
    description="Slack-triggered parallel agents; FetchSandbox twin + managed-tunnel verify surface.",
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
    run_id: str | None = None
    case_id: str | None = None


class ProcessBody(BaseModel):
    """FetchSandbox action body for POST /process-workflow."""

    customer_email: str = "ada@example.test"
    customer_name: str | None = "Ada Lovelace"
    company: str | None = "Acme Analytics"
    sku: str = "pro_annual"
    quantity: int = 3
    channel: str | None = Field(default=None, description="Slack channel id")
    channel_id: str | None = None
    notes: str | None = None
    run_id: str | None = None
    case_id: str | None = None
    idempotency_key: str | None = None


def _require_verifier(request: Request) -> None:
    token = os.environ.get("FETCHSANDBOX_VERIFIER_TOKEN")
    if not token:
        return
    auth = request.headers.get("authorization") or ""
    if auth not in {f"Bearer {token}", f"bearer {token}"}:
        raise HTTPException(401, "unauthorized")


def _workflow_summary(record, *, run_id: str | None, case_id: str | None) -> dict[str, Any]:
    agents = record.agent_results
    billing = agents.get("billing")
    handoff = agents.get("handoff")
    survey = agents.get("survey")
    quote = agents.get("quote")
    research = agents.get("research")

    def ok(name: str) -> bool:
        r = agents.get(name)
        return bool(r and r.status.value == "succeeded")

    return {
        "workflowKey": f"{record.request.customer_email}|{record.request.sku}|{record.idempotency_key}".lower(),
        "workflow_id": record.workflow_id,
        "status": record.status.value,
        "customer_email": record.request.customer_email,
        "sku": record.request.sku,
        "quantity": record.request.quantity,
        "researchOk": ok("research"),
        "quoteOk": ok("quote"),
        "billingOk": ok("billing"),
        "handoffOk": ok("handoff"),
        "surveyOk": ok("survey"),
        "stripeOk": ok("billing"),
        "hubspotOk": ok("handoff"),
        "gmailOk": ok("survey"),
        "slackOk": ok("handoff"),
        "payment_intent_id": (billing.output.get("payment_intent_id") if billing else None),
        "hubspot_deal_id": (handoff.output.get("hubspot_deal_id") if handoff else None),
        "survey_message_id": (survey.output.get("message_id") if survey else None),
        "quote_total_cents": (quote.output.get("total_cents") if quote else None),
        "company": (research.output.get("company") if research else record.request.company),
        "runId": run_id,
        "caseId": case_id,
        "deduped": bool(record.summary.get("duplicate_trigger")),
    }


def _run_request(req: WorkflowRequest, *, run_id: str | None, case_id: str | None) -> dict[str, Any]:
    record = Orchestrator().start(req)
    summary = _workflow_summary(record, run_id=run_id, case_id=case_id)
    # Duplicates must not append again so FetchSandbox count assertions stay stable.
    if not summary["deduped"]:
        observe.push_workflow(summary, run_id=run_id, case_id=case_id)
    return {"ok": True, "result": summary, "workflow_id": record.workflow_id, "status": record.status.value}


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "flowHeader": bool(os.environ.get("X_FLOW_RUN_ID")),
        "verifierRequired": bool(os.environ.get("FETCHSANDBOX_VERIFIER_TOKEN")),
    }


@app.post("/workflows")
def start_workflow(body: StartBody) -> dict[str, Any]:
    channel = body.channel_id
    slack = None
    if channel:
        slack = SlackTrigger(
            event_id=body.idempotency_key or f"http-{body.customer_email}-{body.sku}",
            channel_id=channel,
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
    summary = _workflow_summary(record, run_id=body.run_id, case_id=body.case_id)
    observe.push_workflow(summary, run_id=body.run_id, case_id=body.case_id)
    return {
        "workflow_id": record.workflow_id,
        "status": record.status.value,
        "idempotency_key": record.idempotency_key,
        "request": record.request.model_dump(mode="json"),
        "agent_results": {k: v.model_dump(mode="json") for k, v in record.agent_results.items()},
        "summary": record.summary,
        "errors": [e.model_dump() for e in record.errors],
        "observe": summary,
    }


@app.post("/process-workflow")
def process_workflow(body: ProcessBody) -> dict[str, Any]:
    """Primary FetchSandbox action entrypoint (mirrors invoice-watch /process-invoice)."""
    channel = body.channel_id or body.channel or os.environ.get("SLACK_CHANNEL") or "C0OPS01"
    idem = body.idempotency_key or (
        f"case:{body.case_id}:{body.customer_email}:{body.sku}"
        if body.case_id
        else None
    )
    trigger = SlackTrigger(
        event_id=idem or f"proc-{body.customer_email}-{time.time()}",
        channel_id=channel,
        user_id="U_FS",
        text=f"email={body.customer_email} case:{body.case_id or 'none'}",
        thread_ts=None,
    )
    req = WorkflowRequest(
        customer_email=body.customer_email,
        customer_name=body.customer_name,
        company=body.company,
        sku=body.sku,
        quantity=body.quantity,
        notes=body.notes,
        slack=trigger,
        idempotency_key=idem,
    )
    return _run_request(req, run_id=body.run_id, case_id=body.case_id)


@app.get("/workflows")
def list_workflows_api(request: Request) -> dict[str, Any]:
    _require_verifier(request)
    return {"workflows": observe.list_workflows()}


@app.get("/workflows/{workflow_id}")
def get_workflow(workflow_id: str) -> dict[str, Any]:
    record = get_store().get(workflow_id)
    if not record:
        raise HTTPException(404, "workflow not found")
    return {
        "workflow_id": record.workflow_id,
        "status": record.status.value,
        "agent_results": {k: v.model_dump(mode="json") for k, v in record.agent_results.items()},
        "summary": record.summary,
    }


@app.get("/runs/{run_id}/workflows")
def run_workflows(run_id: str, request: Request) -> dict[str, Any]:
    _require_verifier(request)
    return {"workflows": observe.list_workflows(run_id=run_id)}


@app.get("/runs/{run_id}/cases/{case_id}/workflows")
def case_workflows(run_id: str, case_id: str, request: Request) -> dict[str, Any]:
    _require_verifier(request)
    return {"workflows": observe.list_workflows(run_id=run_id, case_id=case_id)}


@app.get("/webhooks")
def list_webhooks(request: Request) -> dict[str, Any]:
    _require_verifier(request)
    return {"webhooks": observe.list_webhooks()}


@app.get("/runs/{run_id}/webhooks")
def run_webhooks(run_id: str, request: Request) -> dict[str, Any]:
    _require_verifier(request)
    return {"webhooks": observe.list_webhooks(run_id=run_id)}


@app.get("/runs/{run_id}/cases/{case_id}/webhooks")
def case_webhooks(run_id: str, case_id: str, request: Request) -> dict[str, Any]:
    _require_verifier(request)
    return {"webhooks": observe.list_webhooks(run_id=run_id, case_id=case_id)}


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

    event = payload.get("event") or {}
    if event.get("type") not in {"app_mention", "message"}:
        return {"ok": True, "ignored": True}
    if event.get("bot_id") or event.get("subtype") == "bot_message":
        return {"ok": True, "ignored": "bot"}

    text = event.get("text") or ""
    try:
        fields = parse_slack_text(text)
    except ValueError as exc:
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


async def _handle_slack_webhook(request: Request, *, auth: str) -> dict[str, Any]:
    raw = await request.body()
    if auth == "slack_signature":
        gate = _slack_sig_gate(raw, request.headers)
    else:
        gate = _verifier_gate(request.headers)
    if not gate["ok"]:
        raise HTTPException(400, gate.get("reason") or "invalid_signature")

    try:
        payload = await request.json() if raw else {}
    except Exception:
        raise HTTPException(400, "invalid_json") from None

    if payload.get("type") == "url_verification" and payload.get("challenge"):
        observe.push_webhook(
            {
                "provider": "slack",
                "type": "url_verification",
                "ok": True,
                "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
        )
        return {"challenge": payload["challenge"]}

    event = payload.get("event") or {}
    event_type = event.get("type") or payload.get("type") or "unknown"
    event_id = (
        payload.get("event_id")
        or event.get("event_id")
        or event.get("client_msg_id")
        or event.get("ts")
    )
    replay = observe.webhook_seen("slack", event_id)
    text = str(event.get("text") or payload.get("text") or "")
    import re

    text_case = (re.search(r"\bcase:([a-z0-9_]+)\b", text, re.I) or [None, None])[1]
    wh_run = (
        payload.get("run_id")
        or event.get("run_id")
        or request.headers.get("x-flow-run-id")
    )
    wh_case = (
        payload.get("case_id")
        or event.get("case_id")
        or (event.get("metadata") or {}).get("case_id")
        or text_case
    )
    entry = {
        "provider": "slack",
        "type": event_type,
        "eventId": event_id,
        "replay": replay,
        "runId": wh_run,
        "caseId": wh_case,
        "ok": not replay,
        "via": gate.get("via") or auth,
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    observe.push_webhook(entry)

    # Optionally drive workflow from app_mention text when parseable
    if not replay and event_type in {"app_mention", "message"} and "@" in text:
        try:
            fields = parse_slack_text(text)
            trigger = SlackTrigger(
                event_id=str(event_id),
                channel_id=event.get("channel") or "C0OPS01",
                user_id=event.get("user") or "U_FS",
                thread_ts=event.get("thread_ts") or event.get("ts"),
                text=text,
            )
            req = WorkflowRequest(
                **fields,
                slack=trigger,
                idempotency_key=f"slack:{event_id}",
            )
            _run_request(req, run_id=wh_run, case_id=wh_case)
        except ValueError:
            pass

    return {"ok": True, "deduped": replay}


@app.post("/webhooks/slack")
async def webhooks_slack(request: Request) -> dict[str, Any]:
    """Production Slack Events route — strict X-Slack-Signature."""
    return await _handle_slack_webhook(request, auth="slack_signature")


@app.post("/webhooks/slack/fs")
async def webhooks_slack_fs(request: Request) -> dict[str, Any]:
    """FetchSandbox direct event delivery (verifier Bearer)."""
    return await _handle_slack_webhook(request, auth="verifier_bearer")


@app.post("/webhooks/stripe")
async def webhooks_stripe(request: Request) -> dict[str, Any]:
    """Stripe webhook — signature required when STRIPE_WEBHOOK_SECRET is set."""
    raw = await request.body()
    secret = os.environ.get("STRIPE_WEBHOOK_SECRET") or os.environ.get(
        "FETCHSANDBOX_STRIPE_WEBHOOK_SECRET"
    )
    sig_header = request.headers.get("stripe-signature")
    if secret:
        if not sig_header or not _verify_stripe_sig(raw, sig_header, secret):
            raise HTTPException(400, "invalid_stripe_signature")
        via = "stripe_signature"
    else:
        # Allow verifier bearer during FS direct delivery without Stripe sig
        gate = _verifier_gate(request.headers)
        if not gate["ok"] and os.environ.get("CUSTOMER_OPS_REQUIRE_STRIPE_SIG") == "1":
            raise HTTPException(400, "invalid_stripe_signature")
        via = gate.get("via") or "open"

    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(400, "invalid_json") from None

    event_id = payload.get("id")
    event_type = payload.get("type") or "unknown"
    replay = observe.webhook_seen("stripe", event_id)
    obj = (payload.get("data") or {}).get("object") or {}
    entry = {
        "provider": "stripe",
        "type": event_type,
        "eventId": event_id,
        "replay": replay,
        "runId": request.headers.get("x-flow-run-id") or payload.get("run_id"),
        "caseId": payload.get("case_id") or (obj.get("metadata") or {}).get("case_id"),
        "payment_intent_id": obj.get("id") if obj.get("object") == "payment_intent" else obj.get("payment_intent"),
        "ok": not replay,
        "via": via,
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    observe.push_webhook(entry)
    return {"ok": True, "deduped": replay}


@app.post("/dev/reset")
def dev_reset() -> dict[str, str]:
    """Clear in-memory observe + store (local / twin-driver only)."""
    if os.environ.get("CUSTOMER_OPS_ALLOW_RESET", "1") not in {"1", "true", "True"}:
        raise HTTPException(403, "reset disabled")
    observe.reset()
    reset_store_for_tests()
    return {"status": "reset"}


def _slack_sig_gate(raw: bytes, headers) -> dict[str, Any]:
    secret = (
        os.environ.get("FETCHSANDBOX_SLACK_WEBHOOK_SECRET")
        or os.environ.get("SLACK_SIGNING_SECRET")
    )
    if not secret:
        if os.environ.get("REQUIRE_SLACK_SIGNATURE") == "1":
            return {"ok": False, "reason": "missing_signing_secret"}
        return {"ok": True, "skipped": True}
    timestamp = headers.get("x-slack-request-timestamp")
    signature = headers.get("x-slack-signature")
    if not timestamp or not signature:
        return {"ok": False, "reason": "missing_signature"}
    if abs(time.time() - int(timestamp)) > 60 * 5:
        return {"ok": False, "reason": "stale_timestamp"}
    base = b"v0:" + str(timestamp).encode() + b":" + raw
    digest = "v0=" + hmac.new(secret.encode(), base, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(digest, signature):
        return {"ok": False, "reason": "bad_signature"}
    return {"ok": True, "via": "slack_signature"}


def _verifier_gate(headers) -> dict[str, Any]:
    token = os.environ.get("FETCHSANDBOX_VERIFIER_TOKEN")
    if not token:
        return {"ok": True, "skipped": True}
    auth = headers.get("authorization") or ""
    if auth not in {f"Bearer {token}", f"bearer {token}"}:
        return {"ok": False, "reason": "missing_verifier"}
    return {"ok": True, "via": "verifier_bearer"}


def _verify_stripe_sig(payload: bytes, header: str, secret: str) -> bool:
    """Minimal Stripe-Signature check (t=…,v1=…)."""
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    timestamp = parts.get("t")
    signature = parts.get("v1")
    if not timestamp or not signature:
        return False
    signed = f"{timestamp}.".encode() + payload
    expect = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expect, signature)


def _verify_slack(body: bytes, signature: str | None, timestamp: str | None) -> None:
    secret = os.environ.get("SLACK_SIGNING_SECRET")
    if not secret:
        if os.environ.get("CUSTOMER_OPS_REQUIRE_SLACK_SIG") == "1":
            raise HTTPException(401, "SLACK_SIGNING_SECRET not configured")
        return
    gate = _slack_sig_gate(
        body,
        {"x-slack-signature": signature, "x-slack-request-timestamp": timestamp},
    )
    if not gate["ok"]:
        raise HTTPException(401, gate.get("reason") or "invalid Slack signature")
