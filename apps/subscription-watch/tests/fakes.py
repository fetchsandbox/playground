"""In-memory Gmail + Calendar + Slack, served through httpx.MockTransport."""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field

import httpx


def raw_email(sender: str, subject: str, body: str, date: str = "Tue, 13 Oct 2026 10:00:00 +0000",
              content_type: str = "text/plain") -> str:
    msg = (
        f"From: {sender}\r\nTo: me@example.test\r\nSubject: {subject}\r\nDate: {date}\r\n"
        f"Content-Type: {content_type}; charset=utf-8\r\n\r\n{body}\r\n"
    )
    return base64.urlsafe_b64encode(msg.encode()).decode().rstrip("=")


@dataclass
class FakeProviders:
    messages: dict[str, str] = field(default_factory=dict)  # id -> raw
    slack_posts: list[dict] = field(default_factory=list)
    events: dict[str, dict] = field(default_factory=dict)
    calls: list[str] = field(default_factory=list)
    # Fault switches
    slack_error: str | None = None
    slack_429_once: bool = False
    slack_lose_response: bool = False  # Slack stores the post, the response is lost
    calendar_status: int | None = None
    gmail_status: int | None = None

    def add(self, message_id: str, raw: str) -> None:
        self.messages[message_id] = raw

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def _handle(self, req: httpx.Request) -> httpx.Response:
        path = req.url.path
        self.calls.append(f"{req.method} {req.url.host}{path}")
        host = req.url.host
        if host == "gmail.test":
            if self.gmail_status:
                return httpx.Response(self.gmail_status, json={"error": {"code": self.gmail_status}})
            if path == "/gmail/v1/users/me/messages":
                return httpx.Response(200, json={"messages": [{"id": i} for i in self.messages]})
            mid = path.rsplit("/", 1)[-1]
            if mid not in self.messages:
                return httpx.Response(404, json={"error": {"code": 404}})
            return httpx.Response(200, json={"id": mid, "raw": self.messages[mid]})
        if host == "slack.test" and path == "/api/conversations.history":
            msgs = [{"ts": p["ts"], "text": p["text"]} for p in reversed(self.slack_posts)]
            return httpx.Response(200, json={"ok": True, "messages": msgs, "has_more": False})
        if host == "slack.test" and path == "/api/chat.postMessage":
            if self.slack_429_once:
                self.slack_429_once = False
                return httpx.Response(429, headers={"Retry-After": "0"}, json={"ok": False, "error": "ratelimited"})
            if self.slack_error:
                return httpx.Response(200, json={"ok": False, "error": self.slack_error})
            body = json.loads(req.content)
            ts = f"1760000000.{len(self.slack_posts):06d}"
            self.slack_posts.append({**body, "ts": ts})
            if self.slack_lose_response:
                self.slack_lose_response = False
                return httpx.Response(504, text="gateway timeout")
            return httpx.Response(200, json={"ok": True, "channel": body["channel"], "ts": ts})
        if host == "calendar.test" and path == "/calendars/primary/events":
            if self.calendar_status:
                return httpx.Response(self.calendar_status, json={"error": {"code": self.calendar_status}})
            body = json.loads(req.content)
            if body["id"] in self.events:
                return httpx.Response(409, json={"error": {"code": 409, "message": "duplicate"}})
            self.events[body["id"]] = body
            return httpx.Response(200, json=body)
        return httpx.Response(404, json={"error": "unexpected " + path})
