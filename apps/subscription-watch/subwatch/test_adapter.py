"""Test-only routes for driving the workflow from an external verifier.

Mounted only when SUBWATCH_TEST_ADAPTER=1 and SUBWATCH_VERIFIER_TOKEN is set;
every route requires `Authorization: Bearer <SUBWATCH_VERIFIER_TOKEN>`.
Never enable this in production.

  POST /test/inbox/{tag}   drop a synthetic email (kind: subscription|personal)
                           into the configured Gmail via messages.insert
  GET  /test/records/{tag} the workflow's saved records for that tag's emails
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
from .google_auth import google_access_token
from .store import Store

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
        sender, subject, text = EMAILS[kind]
        msg = (
            f"From: {sender}\r\nTo: me@example.test\r\nSubject: {subject} {marker}\r\n"
            f"Date: {email.utils.formatdate(usegmt=True)}\r\nMessage-ID: <{uuid.uuid4()}@subwatch.test>\r\n"
            f"Content-Type: text/plain; charset=utf-8\r\n\r\n{text}\r\n"
        )
        raw = base64.urlsafe_b64encode(msg.encode()).decode().rstrip("=")
        headers = {"Authorization": f"Bearer {google_access_token(settings)}", **settings.provider_extra_headers}
        r = httpx.post(f"{settings.gmail_base_url}/gmail/v1/users/{settings.gmail_user}/messages",
                       headers=headers, json={"raw": raw, "labelIds": ["INBOX", "UNREAD"]},
                       timeout=settings.http_timeout)
        if r.status_code >= 300:
            raise HTTPException(502, f"gmail insert failed: HTTP {r.status_code}")
        return {"id": r.json()["id"], "kind": kind, "tag": tag}

    @router.get("/records/{tag}")
    def records(tag: str) -> dict[str, Any]:
        marker = check_tag(tag)
        found = [r for r in store.all(1000) if marker in (r.get("subject") or "")]
        return {"records": found, "count": len(found)}

    return router
