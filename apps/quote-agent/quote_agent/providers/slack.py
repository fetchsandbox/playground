"""Slack Web API client + request signature verification.

Slack answers most failures with HTTP 200 and `{"ok": false}`, so every call
checks `ok` — a 200 alone does not mean the message was posted.
"""

import hashlib
import hmac
import time
from typing import Any

import httpx


class SlackError(RuntimeError):
    pass


def verify_signature(signing_secret: str, timestamp: str | None, signature: str | None,
                     raw_body: bytes, *, now: float | None = None, tolerance: int = 300) -> bool:
    """Verify X-Slack-Signature against the raw (un-parsed) request body."""
    if not signing_secret or not timestamp or not signature:
        return False
    try:
        ts = int(timestamp)
    except ValueError:
        return False
    if abs((now if now is not None else time.time()) - ts) > tolerance:
        return False  # replayed or badly skewed request
    base = b"v0:" + timestamp.encode() + b":" + raw_body
    expected = "v0=" + hmac.new(signing_secret.encode(), base, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


class SlackClient:
    def __init__(self, base_url: str, bot_token: str, http: httpx.Client | None = None):
        self._http = http or httpx.Client(timeout=15.0)
        self.base_url = base_url.rstrip("/")
        self.headers = {"Authorization": f"Bearer {bot_token}"}

    def _call(self, method: str, payload: dict[str, Any], *, http_method: str = "POST") -> dict[str, Any]:
        for attempt in range(3):
            if http_method == "GET":
                r = self._http.get(f"{self.base_url}/{method}", headers=self.headers, params=payload)
            else:
                r = self._http.post(f"{self.base_url}/{method}",
                                    headers={**self.headers, "Content-Type": "application/json; charset=utf-8"},
                                    json=payload)
            if r.status_code == 429 and attempt < 2:
                time.sleep(min(float(r.headers.get("Retry-After", "1")), 10.0))
                continue
            break
        if r.status_code >= 300:
            raise SlackError(f"{method}: HTTP {r.status_code}")
        data = r.json()
        if not data.get("ok"):
            needed = f" (needed: {data['needed']})" if data.get("needed") else ""
            raise SlackError(f"{method}: {data.get('error', 'unknown_error')}{needed}")
        return data

    def post_message(self, channel: str, text: str, *, blocks: list | None = None,
                     thread_ts: str | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"channel": channel, "text": text}
        if blocks:
            payload["blocks"] = blocks
        if thread_ts:
            payload["thread_ts"] = thread_ts
        return self._call("chat.postMessage", payload)

    def update_message(self, channel: str, ts: str, text: str, *, blocks: list | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"channel": channel, "ts": ts, "text": text, "blocks": blocks or []}
        return self._call("chat.update", payload)

    def user_profile(self, user_id: str) -> dict[str, Any]:
        """Needs users:read and users:read.email to return the email."""
        return self._call("users.info", {"user": user_id}, http_method="GET")["user"].get("profile", {})
