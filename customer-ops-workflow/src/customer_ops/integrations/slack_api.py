"""Slack Web API adapter."""

from __future__ import annotations

from typing import Any

import httpx

from customer_ops.integrations.base import IntegrationBus, env, use_mocks
from customer_ops.models import new_id


class SlackClient:
    def __init__(self, bus: IntegrationBus | None = None):
        self.bus = bus or IntegrationBus()
        self.token = env("SLACK_BOT_TOKEN", "CUSTOMER_OPS_SLACK_BOT_TOKEN")
        self.base = env("SLACK_API_BASE", default="https://slack.com/api") or "https://slack.com/api"

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
        payload: dict[str, Any] = {"channel": channel, "text": text}
        if thread_ts:
            payload["thread_ts"] = thread_ts
        headers = {"Authorization": f"Bearer {self.token}"}
        if idempotency_key:
            # Slack doesn't have Idempotency-Key; we still cache locally via bus.
            headers["X-Customer-Ops-Idempotency"] = idempotency_key
        with httpx.Client(timeout=20.0) as client:
            resp = client.post(f"{self.base}/chat.postMessage", json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            if not data.get("ok"):
                raise RuntimeError(f"slack error: {data.get('error')}")
            return self.bus.remember(
                service="slack",
                operation="chat.postMessage",
                request=req,
                response=data,
                idempotency_key=idempotency_key,
            )
