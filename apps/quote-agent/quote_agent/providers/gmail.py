"""Gmail API client: read new inbox messages after a push notification, send replies.

Inbound flow: Gmail `users.watch` -> Pub/Sub topic -> push subscription to
POST /webhooks/gmail. The push only carries a historyId; the actual messages
are fetched with `users.history.list` + `users.messages.get`.
"""

import base64
import time
from email.message import EmailMessage
from email.utils import parseaddr
from typing import Any

import httpx


class GmailError(RuntimeError):
    pass


class GmailClient:
    def __init__(self, *, base_url: str, token_url: str, access_token: str = "", client_id: str = "",
                 client_secret: str = "", refresh_token: str = "", http: httpx.Client | None = None):
        self._http = http or httpx.Client(timeout=20.0)
        self.base_url = base_url.rstrip("/")
        self.token_url = token_url
        self._access_token = access_token
        self._expires_at = float("inf") if access_token and not refresh_token else 0.0
        self.client_id, self.client_secret, self.refresh_token = client_id, client_secret, refresh_token

    def _token(self) -> str:
        if self._access_token and time.time() < self._expires_at - 60:
            return self._access_token
        if not self.refresh_token:
            if self._access_token:
                return self._access_token
            raise GmailError("no Gmail credentials configured")
        r = self._http.post(self.token_url, data={
            "grant_type": "refresh_token", "refresh_token": self.refresh_token,
            "client_id": self.client_id, "client_secret": self.client_secret,
        })
        if r.status_code >= 300:
            raise GmailError(f"token refresh failed: HTTP {r.status_code}")
        body = r.json()
        self._access_token = body["access_token"]
        self._expires_at = time.time() + int(body.get("expires_in", 3600))
        return self._access_token

    def _request(self, method: str, path: str, **kw) -> dict[str, Any]:
        r = self._http.request(method, f"{self.base_url}{path}",
                               headers={"Authorization": f"Bearer {self._token()}"}, **kw)
        if r.status_code == 401 and self.refresh_token:
            self._expires_at = 0.0  # force refresh, retry once
            r = self._http.request(method, f"{self.base_url}{path}",
                                   headers={"Authorization": f"Bearer {self._token()}"}, **kw)
        if r.status_code >= 300:
            raise GmailError(f"{method} {path}: HTTP {r.status_code} {r.text[:300]}")
        return r.json() if r.content else {}

    # --- inbound ------------------------------------------------------------

    def new_message_ids(self, start_history_id: str | None) -> list[str]:
        """Inbox message ids added since start_history_id (or recent unread if none)."""
        if not start_history_id:
            listing = self._request("GET", "/users/me/messages",
                                    params={"q": "in:inbox is:unread newer_than:1d", "maxResults": 10})
            return [m["id"] for m in listing.get("messages", [])]
        ids: list[str] = []
        page_token = None
        while True:
            params = {"startHistoryId": start_history_id, "historyTypes": "messageAdded", "labelId": "INBOX"}
            if page_token:
                params["pageToken"] = page_token
            data = self._request("GET", "/users/me/history", params=params)
            for h in data.get("history", []):
                for added in h.get("messagesAdded", []):
                    msg = added["message"]
                    if "INBOX" in msg.get("labelIds", ["INBOX"]) and msg["id"] not in ids:
                        ids.append(msg["id"])
            page_token = data.get("nextPageToken")
            if not page_token:
                return ids

    def get_message(self, message_id: str) -> dict[str, Any]:
        """Return {id, thread_id, from_email, from_name, subject, message_id_header, text, labels}."""
        msg = self._request("GET", f"/users/me/messages/{message_id}", params={"format": "full"})
        payload = msg.get("payload", {})
        headers = {h["name"].lower(): h["value"] for h in payload.get("headers", [])}
        name, addr = parseaddr(headers.get("from", ""))
        return {
            "id": msg["id"],
            "thread_id": msg.get("threadId"),
            "from_email": addr.lower() or None,
            "from_name": name or None,
            "subject": headers.get("subject", ""),
            "message_id_header": headers.get("message-id"),
            "text": _plain_text(payload) or msg.get("snippet", ""),
            "labels": msg.get("labelIds", []),
        }

    def watch(self, topic_name: str) -> dict[str, Any]:
        """users.watch: push INBOX changes to a Pub/Sub topic. Returns {historyId, expiration}."""
        return self._request("POST", "/users/me/watch", json={"topicName": topic_name, "labelIds": ["INBOX"]})

    # --- outbound -----------------------------------------------------------

    def send(self, *, to: str, subject: str, body: str, sender: str = "",
             thread_id: str | None = None, in_reply_to: str | None = None) -> dict[str, Any]:
        mime = EmailMessage()
        mime["To"] = to
        if sender:
            mime["From"] = sender
        mime["Subject"] = subject
        if in_reply_to:
            mime["In-Reply-To"] = in_reply_to
            mime["References"] = in_reply_to
        mime.set_content(body)
        payload: dict[str, Any] = {"raw": base64.urlsafe_b64encode(mime.as_bytes()).decode()}
        if thread_id:
            payload["threadId"] = thread_id
        sent = self._request("POST", "/users/me/messages/send", json=payload)
        if not sent.get("id"):
            raise GmailError("send returned no message id")
        return sent


def _b64(data: str) -> str:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", errors="replace")


def _plain_text(part: dict[str, Any]) -> str:
    if part.get("mimeType") == "text/plain" and part.get("body", {}).get("data"):
        return _b64(part["body"]["data"])
    for sub in part.get("parts", []) or []:
        text = _plain_text(sub)
        if text:
            return text
    return ""


def decode_push(envelope: dict[str, Any]) -> dict[str, Any]:
    """Decode a Pub/Sub push envelope into {emailAddress, historyId}."""
    import json
    data = (envelope.get("message") or {}).get("data")
    if not data:
        raise GmailError("push envelope has no message.data")
    return json.loads(_b64(data))
