"""HTTP surface: Gmail + Slack webhooks in, run/quote inspection out.

Webhooks verify the request, enqueue a job and acknowledge immediately: Slack
retries any event not acknowledged within 3 seconds, and a Claude call plus
three provider round-trips can take longer than that. The worker (SQS in
production, in-process locally) runs the workflow; see jobs.py.
"""

import json
import logging
import secrets
import uuid
from urllib.parse import parse_qs

import anthropic
import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from .classifier import ClaudeClassifier, IntentClassifier
from .config import Settings
from .handoff import build_handoff
from .handoff.api import build_router as build_handoff_router
from .jobs import JobQueue, build_queue
from .logging_setup import request_id
from .models import InboundMessage
from .orchestrator import Orchestrator
from .pricing import PricingClient
from .pricing import router as pricing_router
from .providers.gmail import GmailClient, GmailError, decode_push
from .providers.hubspot import HubSpotClient
from .providers.slack import SlackClient, verify_signature
from .store import Store

log = logging.getLogger(__name__)


def build_orchestrator(s: Settings) -> Orchestrator:
    use_claude = s.classifier == "claude" or (s.classifier == "auto" and s.anthropic_api_key)
    primary = ClaudeClassifier(anthropic.Anthropic(api_key=s.anthropic_api_key), s.classifier_model) if use_claude else None
    # Extra headers on every provider request (test harnesses use this for run correlation).
    http = httpx.Client(timeout=20.0, headers=s.provider_headers)
    store = Store(s.db_url)
    if s.auto_migrate:
        store.migrate()
    orch = Orchestrator(
        settings=s,
        store=store,
        classifier=IntentClassifier(primary),
        pricing=PricingClient(s.pricing_service_url),
        hubspot=HubSpotClient(s.hubspot_base_url, s.hubspot_token, http=http) if s.hubspot_token else None,
        slack=SlackClient(s.slack_base_url, s.slack_bot_token, http=http) if s.slack_bot_token else None,
        gmail=GmailClient(base_url=s.gmail_base_url, token_url=s.gmail_token_url, access_token=s.gmail_access_token,
                          client_id=s.gmail_client_id, client_secret=s.gmail_client_secret,
                          refresh_token=s.gmail_refresh_token, http=http)
        if (s.gmail_access_token or s.gmail_refresh_token) else None,
    )
    alert = orch._post_manager if (orch.slack and s.slack_manager_channel) else None
    orch.handoff, orch.research = build_handoff(
        s, store, http=httpx.Client(timeout=s.provider_timeout_seconds, headers=s.provider_headers),
        alert=alert, claude=primary.client if primary else None)
    return orch


def create_app(settings: Settings | None = None, orchestrator: Orchestrator | None = None,
               queue: JobQueue | None = None) -> FastAPI:
    s = settings or Settings.from_env()
    orch = orchestrator or build_orchestrator(s)
    jobs = queue or build_queue(s, orch)
    app = FastAPI(title="Quote agent", docs_url=None if s.is_production else "/docs",
                  redoc_url=None, openapi_url=None if s.is_production else "/openapi.json")
    app.include_router(pricing_router)
    if orch.handoff is not None:
        app.include_router(build_handoff_router(s, orch.handoff, orch.research))
    app.state.orchestrator = orch
    app.state.queue = jobs

    @app.middleware("http")
    async def _request_id(request: Request, call_next):
        rid = request.headers.get("X-Request-Id") or uuid.uuid4().hex
        token = request_id.set(rid)
        try:
            response = await call_next(request)
        finally:
            request_id.reset(token)
        response.headers["X-Request-Id"] = rid
        return response

    # ------------------------------------------------------------------ Gmail

    @app.post("/webhooks/gmail")
    async def gmail_push(request: Request, token: str = ""):
        if not s.gmail_push_token or not secrets.compare_digest(token, s.gmail_push_token):
            raise HTTPException(403, "bad push token")
        if orch.gmail is None:
            raise HTTPException(503, "Gmail not configured")
        try:
            note = decode_push(await request.json())
        except (GmailError, ValueError) as exc:
            # 2xx so Pub/Sub doesn't redeliver a message that can never parse.
            log.warning("unparseable Gmail push: %s", exc)
            return {"ok": False}
        jobs.enqueue({"type": "gmail_push", "history_id": str(note.get("historyId", ""))})
        return {"ok": True}

    # ------------------------------------------------------------------ Slack

    async def _verified_body(request: Request) -> bytes:
        raw = await request.body()
        if not verify_signature(s.slack_signing_secret, request.headers.get("X-Slack-Request-Timestamp"),
                                request.headers.get("X-Slack-Signature"), raw):
            raise HTTPException(401, "bad Slack signature")
        return raw

    @app.post("/webhooks/slack/events")
    async def slack_events(request: Request):
        body = json.loads(await _verified_body(request))
        if body.get("type") == "url_verification":
            return {"challenge": body.get("challenge")}
        if body.get("type") != "event_callback":
            return {"ok": True}
        event = body.get("event") or {}
        if not _is_customer_message(event, s):
            return {"ok": True}
        jobs.enqueue({"type": "slack_event", "event": event,
                      "event_id": body.get("event_id") or event.get("client_msg_id") or event["ts"]})
        return {"ok": True}

    @app.post("/webhooks/slack/interactions")
    async def slack_interactions(request: Request):
        raw = await _verified_body(request)
        payload = json.loads(parse_qs(raw.decode()).get("payload", ["{}"])[0])
        if payload.get("type") != "block_actions":
            return {"ok": True}
        user_id = (payload.get("user") or {}).get("id", "")
        for action in payload.get("actions", []):
            if action.get("action_id") not in {"discount_approve", "discount_reject"}:
                continue
            if user_id not in s.slack_manager_user_ids:
                return JSONResponse({"response_type": "ephemeral", "replace_original": False,
                                     "text": "Only an authorised manager can approve or reject discounts."})
            decision = "approved" if action["action_id"] == "discount_approve" else "rejected"
            jobs.enqueue({"type": "approval_decision", "approval_id": action["value"],
                          "decision": decision, "user_id": user_id})
        return {"ok": True}

    # ------------------------------------------------------------- Inspection
    # Runs and quotes hold customer emails and message text: admin token required.

    def _admin(authorization: str | None = Header(None)) -> None:
        if not s.admin_token:
            raise HTTPException(404, "inspection API disabled (set QUOTE_AGENT_ADMIN_TOKEN)")
        if not authorization or not secrets.compare_digest(authorization, f"Bearer {s.admin_token}"):
            raise HTTPException(401, "admin token required")

    @app.get("/runs", dependencies=[Depends(_admin)])
    def list_runs(limit: int = 50):
        return {"runs": orch.store.list_runs(limit)}

    @app.get("/runs/{run_id}", dependencies=[Depends(_admin)])
    def get_run(run_id: str):
        run = orch.store.get_run(run_id)
        if not run:
            raise HTTPException(404, "run not found")
        return run

    @app.get("/quotes", dependencies=[Depends(_admin)])
    def list_quotes(limit: int = 50):
        return {"quotes": [q.model_dump() for q in orch.store.list_quotes(limit)]}

    @app.get("/quotes/{quote_id}", dependencies=[Depends(_admin)])
    def get_quote(quote_id: str):
        q = orch.store.get_quote(quote_id)
        if not q:
            raise HTTPException(404, "quote not found")
        return q.model_dump()

    @app.get("/health")
    def health():
        """Liveness: the process is serving. Used by the load balancer."""
        return {"ok": True, "classifier": "claude" if orch.classifier.primary else "rules",
                "hubspot": orch.hubspot is not None, "slack": orch.slack is not None, "gmail": orch.gmail is not None}

    @app.get("/ready")
    def ready():
        """Readiness: dependencies reachable. 503 takes the task out of rotation."""
        if not orch.store.ping():
            return JSONResponse({"ok": False, "database": False}, status_code=503)
        return {"ok": True, "database": True}

    # ------------------------------------------------- Local testing (opt-in)

    if s.verifier_token:
        from .verifier import build_router
        app.include_router(build_router(orch, s.verifier_token))

    if s.dev_endpoints:
        @app.post("/dev/inbound")
        def dev_inbound(msg: InboundMessage):
            """Run the workflow synchronously on a hand-made message."""
            return orch.handle_inbound(msg) or {"duplicate": True}

        @app.post("/dev/quotes")
        def dev_quote(body: dict):
            """Test fixture: a sent quote priced from the catalog, without any provider call."""
            from datetime import datetime, timedelta, timezone
            from .models import Product, Quote, RequestedItem
            from .pricing import price_items
            priced = price_items([RequestedItem(product=Product(body.get("product", "starter")),
                                                quantity=int(body.get("seats", 10)))])
            now = datetime.now(timezone.utc)
            quote = Quote(id=f"Q-{uuid.uuid4().hex[:8].upper()}", customer_email=body["customer_email"].lower(),
                          customer_name=body.get("customer_name"), lines=priced.lines,
                          subtotal_cents=priced.subtotal_cents, total_cents=priced.subtotal_cents, status="sent",
                          created_at=now.isoformat(timespec="seconds"),
                          valid_until=(now + timedelta(days=s.quote_valid_days)).date().isoformat())
            orch.store.save_quote(quote)
            return quote.model_dump()

        @app.post("/dev/approvals/{approval_id}/{decision}")
        def dev_decide(approval_id: str, decision: str, by: str = "dev"):
            try:
                return orch.resume_approval(approval_id, decision, by) or {"already_decided": True}
            except (KeyError, ValueError) as exc:
                raise HTTPException(404, str(exc)) from exc

    return app


def _is_customer_message(event: dict, s: Settings) -> bool:
    if event.get("bot_id") or event.get("subtype"):  # our own posts, edits, joins...
        return False
    if event.get("type") == "app_mention":
        return True
    if event.get("type") != "message":
        return False
    return event.get("channel_type") == "im" or event.get("channel") in s.slack_intake_channels


