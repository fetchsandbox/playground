"""Gmail: list candidate messages and fetch each one as raw RFC 822.

The app parses the raw message itself rather than trusting `payload.headers`,
so the same code path works for any MIME layout Gmail hands back.
"""

from __future__ import annotations

import base64
import binascii
import email
import email.policy
import email.utils
import html
import re
from dataclasses import dataclass
from datetime import datetime

import httpx

from .http import raise_for_google, send


@dataclass(frozen=True)
class Email:
    id: str
    sender_name: str
    sender_address: str
    subject: str
    date: datetime | None
    body: str


class GmailClient:
    def __init__(self, client: httpx.Client, user: str, max_retry_after: float):
        self._c = client
        self._user = user
        self._max_retry_after = max_retry_after

    def list_message_ids(self, query: str, limit: int = 200) -> list[str]:
        ids: list[str] = []
        page_token: str | None = None
        while len(ids) < limit:
            params = {"q": query, "maxResults": min(100, limit - len(ids))}
            if page_token:
                params["pageToken"] = page_token
            r = send(self._c, "gmail", "GET", f"/gmail/v1/users/{self._user}/messages",
                     params=params, max_retry_after=self._max_retry_after)
            raise_for_google("gmail", r)
            body = r.json()
            ids.extend(m["id"] for m in body.get("messages") or [])
            page_token = body.get("nextPageToken")
            if not page_token:
                break
        return ids

    def get_message(self, message_id: str) -> Email | None:
        """Return the parsed message, or None if Gmail has no usable raw body."""
        r = send(self._c, "gmail", "GET", f"/gmail/v1/users/{self._user}/messages/{message_id}",
                 params={"format": "raw"}, max_retry_after=self._max_retry_after)
        if r.status_code == 404:
            return None
        raise_for_google("gmail", r)
        raw = r.json().get("raw")
        if not raw:
            return None
        return parse_raw(message_id, raw)


def parse_raw(message_id: str, raw_b64url: str) -> Email | None:
    try:
        data = base64.urlsafe_b64decode(raw_b64url + "=" * (-len(raw_b64url) % 4))
    except (binascii.Error, ValueError):
        return None
    msg = email.message_from_bytes(data, policy=email.policy.default)
    if not msg.get("From") and not msg.get("Subject"):
        return None  # not an RFC 822 message
    name, addr = email.utils.parseaddr(str(msg.get("From", "")))
    try:
        date = email.utils.parsedate_to_datetime(str(msg["Date"])) if msg.get("Date") else None
    except (TypeError, ValueError):
        date = None
    return Email(
        id=message_id,
        sender_name=name,
        sender_address=addr.lower(),
        subject=str(msg.get("Subject", "")),
        date=date,
        body=_body_text(msg),
    )


def _body_text(msg: email.message.EmailMessage) -> str:
    part = msg.get_body(preferencelist=("plain", "html"))
    if part is None:
        return ""
    if part.get_param("charset") is None:
        # 8-bit body with no declared charset: real senders do this; UTF-8 is the usual intent.
        raw = part.get_payload(decode=True) or b""
        text = raw.decode("utf-8", errors="replace")
    else:
        try:
            text = part.get_content()
        except (LookupError, ValueError):
            return ""
    if part.get_content_type() == "text/html":
        text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    return re.sub(r"\s+", " ", text).strip()
