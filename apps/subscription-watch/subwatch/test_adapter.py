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
  POST /test/forget-slack/{tag}  clear only the saved Slack ts (simulates an
                           accepted post whose response was lost)
  GET  /test/runtime       process identity, to observe a restart
"""

from __future__ import annotations

import base64
import email.utils
import hmac
import quopri
import re
import uuid
from email.header import Header as MimeHeader
from typing import Any, Callable

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException

from .config import Settings
from .gcal import event_id_for
from .google_auth import google_access_token
from .store import Store

INSTANCE_ID = uuid.uuid4().hex
_TAG = re.compile(r"^[A-Za-z0-9_-]{1,80}$")

def _headers(sender: str, subject: str) -> str:
    return (f"From: {sender}\r\nTo: me@example.test\r\nSubject: {subject}\r\n"
            f"Date: {email.utils.formatdate(usegmt=True)}\r\nMessage-ID: <{uuid.uuid4()}@subwatch.test>\r\n"
            "MIME-Version: 1.0\r\n")


def _plain(sender: str, subject: str, body: str, charset: str | None = "utf-8") -> Callable[[str], str]:
    ctype = f"text/plain; charset={charset}" if charset else "text/plain"
    return lambda m: _headers(sender, f"{subject} {m}") + f"Content-Type: {ctype}\r\n\r\n{body}\r\n"


def _html_only(m: str) -> str:
    return (_headers("Spotify <no-reply@spotify.com>", f"Your Spotify Premium receipt {m}")
            + "Content-Type: text/html; charset=utf-8\r\n\r\n<html><body><p>Your Premium <b>subscription</b> "
              "renews on 14 November 2026.</p><p>Total:&nbsp;&euro;10.99</p></body></html>\r\n")


def _multipart_qp(m: str) -> str:
    text = quopri.encodestring("Your Creative Cloud annual plan subscription payment of $239.88 was successful. "
                               "We\u2019ll renew it automatically. Your plan will renew on Oct 30, 2027.".encode()).decode()
    return (_headers("Adobe <mail@mail.adobe.com>", f"Your Adobe Creative Cloud invoice {m}")
            + "Content-Type: multipart/alternative; boundary=XYZ\r\n\r\n--XYZ\r\n"
              "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n"
            + text + "\r\n--XYZ\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>See text part</p>\r\n--XYZ--\r\n")


def _encoded_headers(m: str) -> str:
    sender = "=?UTF-8?B?" + base64.b64encode(b"Disney+").decode() + "?= <disneyplus@mail.disneyplus.com>"
    subject = MimeHeader(f"Your Disney+ subscription receipt \u2713 {m}", "utf-8").encode()
    return (_headers(sender, subject) + "Content-Type: text/plain; charset=utf-8\r\n\r\n"
            "You were charged $13.99. Your subscription renews on November 20, 2026.\r\n")


EMAILS: dict[str, Callable[[str], str]] = {
    "subscription": _plain("Netflix <info@account.netflix.com>", "Your Netflix subscription payment receipt",
                           "Your monthly subscription of $15.49 was charged. Next billing date: November 13, 2026."),
    "personal": _plain("Priya <priya@example.test>", "Lunch thursday?", "Want to grab lunch at noon?"),
    "html_only": _html_only,
    "multipart_qp": _multipart_qp,
    "encoded_headers": _encoded_headers,
    "no_renewal_date": _plain("billing@notion.so", "Invoice #4821 for your Plus plan",
                              "Thanks! Your annual plan subscription total: 96.00 USD."),
    "trial_ending": _plain("Canva <no-reply@canva.com>", "Your Canva Pro trial ends soon",
                           "Your free trial ends on 2026-11-30. After that you will be charged $119.99 per year."),
    "gbp_no_charset": _plain("The Guardian <membership@theguardian.com>", "Your membership payment receipt",
                             "We received your monthly membership payment of \u00a37.99. Next payment date: 15/11/2026.",
                             charset=None),
    "newsletter": _plain("News <news@site.test>", "Weekly digest: receipts of great ideas",
                         "Great reads this week. Click here to unsubscribe."),
    "shipping": _plain("Amazon <ship@amazon.com>", "Your payment receipt", "Your subscription box order has shipped."),
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
        msg = EMAILS[kind](marker)
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
                mine = [] if history is None else [m for m in history if link in (m.get("text") or "")]
                r["slack_messages"] = None if history is None else len(mine)
                r["slack_text_names_vendor"] = bool(mine) and all(r.get("vendor", "\0") in (m.get("text") or "") for m in mine)
                eid = event_id_for(r["message_id"])
                g = cal.get(f"/calendars/{settings.calendar_id}/events/{eid}")
                r["calendar_get_status"] = g.status_code
                r["calendar_get_summary"] = g.json().get("summary") if g.status_code == 200 else None
                r["calendar_get_start"] = (g.json().get("start") or {}).get("date") if g.status_code == 200 else None
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

    @router.post("/forget-slack/{tag}")
    def forget_slack(tag: str) -> dict[str, Any]:
        """Simulate an accepted Slack post whose response never reached the app."""
        marker = check_tag(tag)
        n = 0
        for r in store.all(1000):
            if marker in (r.get("subject") or "") and r.get("slack_ts"):
                r.pop("slack_ts")
                r["status"] = "failed"
                store.put(r)
                n += 1
        return {"forgotten": n}

    @router.get("/runtime")
    def runtime() -> dict[str, str]:
        return {"instance_id": INSTANCE_ID}

    return router
