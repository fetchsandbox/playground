"""Test-only routes for driving the workflow from an external verifier.

Mounted only when SUBWATCH_TEST_ADAPTER=1 and SUBWATCH_VERIFIER_TOKEN is set;
every route requires `Authorization: Bearer <SUBWATCH_VERIFIER_TOKEN>`.
Never enable this in production.

  POST /test/inbox/{tag}   drop a synthetic email (kind: subscription|personal,
                           folder: inbox|spam) into Gmail via messages.insert
  GET  /test/records/{tag} the workflow's saved records for that tag's emails
  GET  /test/state/{tag}   those records plus what the providers actually hold:
                           Slack channel messages linking the email, Calendar
                           events.get status and events.list matches
  POST /test/forget/{tag}  drop the app's records for the tag (simulates lost state)
  GET  /test/runtime       process identity, to observe a restart
"""

from __future__ import annotations

import base64
import email.utils
import hmac
import re
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException

from .config import Settings
from .gcal import event_id_for
from .google_auth import google_access_token
from .store import Store

INSTANCE_ID = uuid.uuid4().hex
_TAG = re.compile(r"^[A-Za-z0-9_-]{1,80}$")

EMAILS = {
    "subscription": (
        "Netflix <info@account.netflix.com>",
        "Your Netflix subscription payment receipt",
        "Your monthly subscription of $15.49 was charged. Next billing date: November 13, 2026.",
    ),
    "personal": (
        "Priya <priya@example.test>",
        "Lunch thursday?",
        "Want to grab lunch at noon?",
    ),
}


def build_router(settings: Settings, store: Store, token: str) -> APIRouter:
    def auth(authorization: str | None = Header(default=None)) -> None:
        expected = f"Bearer {token}"
        if not authorization or not hmac.compare_digest(authorization, expected):
            raise HTTPException(401, "verifier token required")

    router = APIRouter(prefix="/test", dependencies=[Depends(auth)])

    def check_tag(tag: str) -> str:
        if not _TAG.match(tag):
            raise HTTPException(400, "bad tag")
        return f"[{tag}]"

    @router.post("/inbox/{tag}")
    def insert(tag: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        marker = check_tag(tag)
        kind = (body or {}).get("kind", "subscription")
        if kind not in EMAILS:
            raise HTTPException(400, f"kind must be one of {sorted(EMAILS)}")
        folder = (body or {}).get("folder", "inbox")
        if folder not in ("inbox", "spam"):
            raise HTTPException(400, "folder must be inbox or spam")
        labels = ["INBOX", "UNREAD"] if folder == "inbox" else ["SPAM", "UNREAD"]
        sender, subject, text = EMAILS[kind]
        msg = (
            f"From: {sender}\r\nTo: me@example.test\r\nSubject: {subject} {marker}\r\n"
            f"Date: {email.utils.formatdate(usegmt=True)}\r\nMessage-ID: <{uuid.uuid4()}@subwatch.test>\r\n"
            f"Content-Type: text/plain; charset=utf-8\r\n\r\n{text}\r\n"
        )
        raw = base64.urlsafe_b64encode(msg.encode()).decode().rstrip("=")
        headers = {"Authorization": f"Bearer {google_access_token(settings)}", **settings.provider_extra_headers}
        r = httpx.post(f"{settings.gmail_base_url}/gmail/v1/users/{settings.gmail_user}/messages",
                       headers=headers, json={"raw": raw, "labelIds": labels},
                       timeout=settings.http_timeout)
        if r.status_code >= 300:
            raise HTTPException(502, f"gmail insert failed: HTTP {r.status_code}")
        return {"id": r.json()["id"], "kind": kind, "tag": tag}

    @router.get("/records/{tag}")
    def records(tag: str) -> dict[str, Any]:
        marker = check_tag(tag)
        found = [r for r in store.all(1000) if marker in (r.get("subject") or "")]
        return {"records": found, "count": len(found)}

    def provider(base: str, token: str) -> httpx.Client:
        return httpx.Client(base_url=base, timeout=settings.http_timeout,
                            headers={"Authorization": f"Bearer {token}", **settings.provider_extra_headers})

    @router.get("/state/{tag}")
    def state(tag: str) -> dict[str, Any]:
        """App records joined with independent provider read-back (no app state trusted)."""
        marker = check_tag(tag)
        found = [r for r in store.all(1000) if marker in (r.get("subject") or "")]
        google = google_access_token(settings)
        with provider(settings.slack_base_url, settings.slack_bot_token) as slack, \
             provider(settings.calendar_base_url, settings.calendar_access_token or google) as cal:
            h = slack.get("/api/conversations.history", params={"channel": settings.slack_channel, "limit": 1000})
            history = h.json().get("messages", []) if h.status_code == 200 and h.json().get("ok") else None
            for r in found:
                link = f"#all/{r['message_id']}"
                r["slack_messages"] = None if history is None else sum(link in (m.get("text") or "") for m in history)
                eid = event_id_for(r["message_id"])
                g = cal.get(f"/calendars/{settings.calendar_id}/events/{eid}")
                r["calendar_get_status"] = g.status_code
                r["calendar_get_summary"] = g.json().get("summary") if g.status_code == 200 else None
                lst = cal.get(f"/calendars/{settings.calendar_id}/events",
                              params={"privateExtendedProperty": f"subwatchGmailMessageId={r['message_id']}"})
                items = lst.json().get("items") if lst.status_code == 200 else None
                r["calendar_events_listed"] = None if items is None else len(items)
        return {"records": found, "count": len(found)}

    @router.post("/forget/{tag}")
    def forget(tag: str) -> dict[str, Any]:
        marker = check_tag(tag)
        ids = [r["message_id"] for r in store.all(1000) if marker in (r.get("subject") or "")]
        for i in ids:
            store.delete(i)
        return {"forgotten": len(ids)}

    @router.get("/runtime")
    def runtime() -> dict[str, str]:
        return {"instance_id": INSTANCE_ID}

    return router
