"""Gmail send adapter (survey emails) — twin-compatible REST."""

from __future__ import annotations

import base64
from email.message import EmailMessage
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


class GmailClient:
    def __init__(self, bus: IntegrationBus | None = None):
        self.bus = bus or IntegrationBus()
        self.token = env("GMAIL_ACCESS_TOKEN", "GOOGLE_ACCESS_TOKEN", "GMAIL_API_KEY")
        self.base = (
            env("GMAIL_API_BASE", "GMAIL_BASE_URL", default="https://gmail.googleapis.com")
            or "https://gmail.googleapis.com"
        )
        self.sender = env("GMAIL_SENDER", default="ops@example.test") or "ops@example.test"

    def send(
        self,
        *,
        to: str,
        subject: str,
        body: str,
        idempotency_key: str,
    ) -> dict[str, Any]:
        req = {"to": to, "subject": subject, "body": body}
        if use_mocks() or not self.token:
            return self.bus.remember(
                service="gmail",
                operation="users.messages.send",
                request=req,
                response={"id": new_id("msg"), "labelIds": ["SENT"], "threadId": new_id("thr")},
                idempotency_key=idempotency_key,
            )

        message = EmailMessage()
        message["To"] = to
        message["From"] = self.sender
        message["Subject"] = subject
        message.set_content(body)
        raw = base64.urlsafe_b64encode(message.as_bytes()).decode("ascii")

        user_id = env("GMAIL_USER_ID", default="me") or "me"
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            **flow_headers(),
        }
        payload = {"raw": raw}
        with httpx.Client(timeout=20.0) as client:
            send_url = join_base(
                self.base, f"/gmail/v1/users/{user_id}/messages/send"
            )
            resp = client.post(send_url, json=payload, headers=headers)
            # Twin sandboxes often 404 messages.send ("Resource me not found")
            # while users.messages.insert succeeds — fall back for twin bases.
            if resp.status_code == 404 and "/sandbox/" in (self.base or ""):
                insert_url = join_base(
                    self.base, f"/gmail/v1/users/{user_id}/messages"
                )
                resp = client.post(insert_url, json=payload, headers=headers)
                operation = "users.messages.insert"
            else:
                operation = "users.messages.send"
            resp.raise_for_status()
            data = resp.json()
            return self.bus.remember(
                service="gmail",
                operation=operation,
                request=req,
                response=data,
                idempotency_key=idempotency_key,
            )
