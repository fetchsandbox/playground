"""Slack: post the alert and confirm Slack actually accepted it.

Slack answers most failures with HTTP 200 and `{"ok": false, "error": ...}`,
so success is decided by the `ok` field, never by the status code.
"""

from __future__ import annotations

import httpx

from .http import ProviderError, send

# Errors that will fail again until a human fixes config or permissions.
_PERMANENT = {
    "channel_not_found", "not_in_channel", "is_archived", "missing_scope",
    "invalid_auth", "not_authed", "account_inactive", "token_revoked",
    "invalid_arguments", "no_text", "msg_too_long", "restricted_action",
}


class SlackClient:
    def __init__(self, client: httpx.Client, channel: str, max_retry_after: float):
        if not channel:
            raise ValueError("SLACK_CHANNEL is not set")
        self._c = client
        self._channel = channel
        self._max_retry_after = max_retry_after

    def find_posted(self, marker: str, oldest: float | None = None, max_pages: int = 5) -> str | None:
        """Return the ts of a channel message containing `marker`, if one exists.

        chat.postMessage has no idempotency key, so this is how a retry after
        lost state or a lost response avoids a second alert. Needs the
        channels:history (or groups:history) scope.
        """
        params: dict = {"channel": self._channel, "limit": 200}
        if oldest is not None:
            params["oldest"] = f"{oldest:.6f}"
        for _ in range(max_pages):
            r = send(self._c, "slack", "GET", "/api/conversations.history",
                     params=params, max_retry_after=self._max_retry_after)
            if r.status_code >= 500:
                raise ProviderError("slack", f"conversations.history HTTP {r.status_code}", r.status_code)
            if r.status_code >= 400:
                raise ProviderError("slack", f"conversations.history HTTP {r.status_code}", r.status_code, retryable=False)
            body = r.json()
            if body.get("ok") is not True:
                err = body.get("error", "unknown_error")
                raise ProviderError("slack", f"conversations.history ok=false: {err}", r.status_code,
                                    retryable=err not in _PERMANENT)
            for m in body.get("messages") or []:
                if marker in (m.get("text") or ""):
                    return m.get("ts")
            cursor = (body.get("response_metadata") or {}).get("next_cursor")
            if not cursor:
                return None
            params["cursor"] = cursor
        return None

    def post(self, text: str) -> str:
        """Post to the configured channel and return the message ts."""
        r = send(self._c, "slack", "POST", "/api/chat.postMessage",
                 json={"channel": self._channel, "text": text, "unfurl_links": False},
                 max_retry_after=self._max_retry_after)
        if r.status_code >= 500:
            raise ProviderError("slack", f"HTTP {r.status_code}", r.status_code)
        if r.status_code >= 400:
            raise ProviderError("slack", f"HTTP {r.status_code}: {r.text[:200]}", r.status_code, retryable=False)
        try:
            body = r.json()
        except ValueError as exc:
            raise ProviderError("slack", f"non-JSON response: {r.text[:200]}", r.status_code) from exc
        if body.get("ok") is not True:
            err = body.get("error", "unknown_error")
            detail = f"{err} (needed={body['needed']})" if body.get("needed") else err
            raise ProviderError("slack", f"chat.postMessage ok=false: {detail}", r.status_code, retryable=err not in _PERMANENT)
        ts = body.get("ts")
        if not ts:
            raise ProviderError("slack", "chat.postMessage ok=true but no ts", r.status_code)
        return ts
