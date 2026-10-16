"""Slack Web API adapter — twin-compatible chat.postMessage."""

from __future__ import annotations

from typing import Any

import httpx

from customer_ops.integrations.base import (
    IntegrationBus,
    env,
    flow_headers,
    join_base,
    use_mocks,
)
from customer_ops.models import new_id


class SlackClient:
    def __init__(self, bus: IntegrationBus | None = None):
        self.bus = bus or IntegrationBus()
        self.token = env("SLACK_BOT_TOKEN", "CUSTOMER_OPS_SLACK_BOT_TOKEN", "SLACK_API_KEY")
        self.base = (
            env("SLACK_API_BASE", "SLACK_BASE_URL", default="https://slack.com/api")
            or "https://slack.com/api"
        )

    def post_message(
        self,
        *,
        channel: str,
        text: str,
        thread_ts: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        req = {"channel": channel, "text": text, "thread_ts": thread_ts}
        if use_mocks() or not self.token:
            return self.bus.remember(
                service="slack",
                operation="chat.postMessage",
                request=req,
                response={"ok": True, "ts": new_id("ts"), "channel": channel},
                idempotency_key=idempotency_key,
            )
        # Twin base already ends at /api or /sandbox/... ; path is chat.postMessage
        # Official: POST {base}/chat.postMessage when base is https://slack.com/api
        # Twin:     POST {sandbox}/api/chat.postMessage when base includes /api
        path = "chat.postMessage"
        if self.base.rstrip("/").endswith("/api") or "/sandbox/" in self.base:
            # if twin base is .../sandbox/x without /api, callers set SLACK_API_BASE to .../sandbox/x
            # invoice-watch uses path `/api/chat.postMessage` against SLACK_BASE_URL
            if not self.base.rstrip("/").endswith("/api"):
                path = "api/chat.postMessage"

        payload: dict[str, Any] = {
            "channel": channel,
            "text": text,
            "unfurl_links": False,
            "unfurl_media": False,
        }
        if thread_ts:
            payload["thread_ts"] = thread_ts
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json; charset=utf-8",
            **flow_headers(),
        }
        if idempotency_key:
            headers["X-Customer-Ops-Idempotency"] = idempotency_key
        with httpx.Client(timeout=20.0) as client:
            resp = client.post(join_base(self.base, path), json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            if data.get("ok") is False:
                raise RuntimeError(f"slack error: {data.get('error')}")
            return self.bus.remember(
                service="slack",
                operation="chat.postMessage",
                request=req,
                response=data,
                idempotency_key=idempotency_key,
            )
