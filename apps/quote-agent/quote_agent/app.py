"""HTTP surface: Gmail + Slack webhooks in, run/quote inspection out.

Webhooks acknowledge immediately and run the workflow in the background:
Slack retries any event not acknowledged within 3 seconds, and a Claude call
plus three provider round-trips can take longer than that.
"""

import json
import logging
import secrets
from urllib.parse import parse_qs

import anthropic
import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from .classifier import ClaudeClassifier, IntentClassifier
from .config import Settings
from .models import InboundMessage
from .orchestrator import Orchestrator
from .pricing import PricingClient
from .pricing import router as pricing_router
from .providers.gmail import GmailClient, GmailError, decode_push
from .providers.hubspot import HubSpotClient
from .providers.slack import SlackClient, SlackError, verify_signature
from .store import Store

log = logging.getLogger(__name__)


def build_orchestrator(s: Settings) -> Orchestrator:
    use_claude = s.classifier == "claude" or (s.classifier == "auto" and s.anthropic_api_key)
    primary = ClaudeClassifier(anthropic.Anthropic(api_key=s.anthropic_api_key), s.classifier_model) if use_claude else None
    # Extra headers on every provider request (test harnesses use this for run correlation).
    http = httpx.Client(timeout=20.0, headers=s.provider_headers)
    return Orchestrator(
        settings=s,
        store=Store(s.db_path),
        classifier=IntentClassifier(primary),
        pricing=PricingClient(s.pricing_service_url),
        hubspot=HubSpotClient(s.hubspot_base_url, s.hubspot_token, http=http) if s.hubspot_token else None,
        slack=SlackClient(s.slack_base_url, s.slack_bot_token, http=http) if s.slack_bot_token else None,
        gmail=GmailClient(base_url=s.gmail_base_url, token_url=s.gmail_token_url, access_token=s.gmail_access_token,
                          client_id=s.gmail_client_id, client_secret=s.gmail_client_secret,
                          refresh_token=s.gmail_refresh_token, http=http)
        if (s.gmail_access_token or s.gmail_refresh_token) else None,
    )


def create_app(settings: Settings | None = None, orchestrator: Orchestrator | None = None) -> FastAPI:
    s = settings or Settings.from_env()
    orch = orchestrator or build_orchestrator(s)
    app = FastAPI(title="Quote agent")
    app.include_router(pricing_router)
    app.state.orchestrator = orch

    # ------------------------------------------------------------------ Gmail

    @app.post("/webhooks/gmail")
    async def gmail_push(request: Request, background: BackgroundTasks, token: str = ""):
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
        background.add_task(_process_gmail, orch, s, str(note.get("historyId", "")))
        return {"ok": True}

    # ------------------------------------------------------------------ Slack

    async def _verified_body(request: Request) -> bytes:
        raw = await request.body()
        if not verify_signature(s.slack_signing_secret, request.headers.get("X-Slack-Request-Timestamp"),
                                request.headers.get("X-Slack-Signature"), raw):
            raise HTTPException(401, "bad Slack signature")
        return raw

    @app.post("/webhooks/slack/events")
    async def slack_events(request: Request, background: BackgroundTasks):
        body = json.loads(await _verified_body(request))
        if body.get("type") == "url_verification":
            return {"challenge": body.get("challenge")}
        if body.get("type") != "event_callback":
            return {"ok": True}
        event = body.get("event") or {}
        if not _is_customer_message(event, s):
            return {"ok": True}
        background.add_task(_process_slack_event, orch, body.get("event_id") or event.get("client_msg_id") or event["ts"], event)
        return {"ok": True}

    @app.post("/webhooks/slack/interactions")
    async def slack_interactions(request: Request, background: BackgroundTasks):
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
            background.add_task(_resume, orch, action["value"], decision, user_id)
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
        return {"ok": True, "classifier": "claude" if orch.classifier.primary else "rules",
                "hubspot": orch.hubspot is not None, "slack": orch.slack is not None, "gmail": orch.gmail is not None}

    # ------------------------------------------------- Local testing (opt-in)

    if s.verifier_token:
        from .verifier import build_router
        app.include_router(build_router(orch, s.verifier_token))

    if s.dev_endpoints:
        @app.post("/dev/inbound")
        def dev_inbound(msg: InboundMessage):
            """Run the workflow synchronously on a hand-made message."""
            return orch.handle_inbound(msg) or {"duplicate": True}

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


def _process_slack_event(orch: Orchestrator, event_id: str, event: dict) -> None:
    email, name = None, None
    try:
        profile = orch.slack.user_profile(event["user"]) if orch.slack else {}
        email = (profile.get("email") or "").lower() or None
        name = profile.get("real_name") or profile.get("display_name") or None
    except SlackError as exc:
        log.warning("could not look up Slack user %s: %s", event.get("user"), exc)
    orch.handle_inbound(InboundMessage(
        channel="slack",
        external_id=event_id,
        sender_email=email,
        sender_name=name,
        text=event.get("text", ""),
        reply_ref={"channel": event["channel"], "ts": event["ts"], "thread_ts": event.get("thread_ts") or event["ts"],
                   "user": event.get("user")},
    ))


def _process_gmail(orch: Orchestrator, s: Settings, history_id: str) -> None:
    cursor = orch.store.get_kv("gmail_history_id")
    try:
        ids = orch.gmail.new_message_ids(cursor)
    except GmailError as exc:
        log.error("Gmail history fetch failed: %s", exc)
        return
    for mid in ids:
        try:
            m = orch.gmail.get_message(mid)
        except GmailError as exc:
            log.error("Gmail message %s fetch failed: %s", mid, exc)
            continue
        if "SENT" in m["labels"] or (s.gmail_address and m["from_email"] == s.gmail_address.lower()):
            continue  # our own replies land in the same thread
        orch.handle_inbound(InboundMessage(
            channel="email",
            external_id=m["id"],
            sender_email=m["from_email"],
            sender_name=m["from_name"],
            subject=m["subject"],
            text=m["text"],
            reply_ref={"thread_id": m["thread_id"], "message_id_header": m["message_id_header"],
                       "subject": m["subject"]},
        ))
    if history_id and (not cursor or int(history_id) > int(cursor)):
        orch.store.set_kv("gmail_history_id", history_id)


def _resume(orch: Orchestrator, approval_id: str, decision: str, user_id: str) -> None:
    try:
        orch.resume_approval(approval_id, decision, user_id)
    except KeyError:
        log.warning("unknown approval %s", approval_id)
