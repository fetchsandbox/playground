"""Resend client for the messaging agent.

Sends carry an Idempotency-Key. Resend keeps the key for 24 hours and answers
a repeat with the original email id instead of sending again, so a send whose
response was lost can be repeated safely with the same key and the same body.
"""

import time
from typing import Any

import httpx


class ResendError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class ResendClient:
    def __init__(self, base_url: str, api_key: str, http: httpx.Client | None = None):
        self._http = http or httpx.Client(timeout=20.0)
        self.base_url = base_url.rstrip("/")
        self.headers = {"Authorization": f"Bearer {api_key}"}

    def send_email(self, *, sender: str, to: list[str], subject: str, text: str,
                   idempotency_key: str) -> dict[str, Any]:
        headers = {**self.headers, "Idempotency-Key": idempotency_key}
        body = {"from": sender, "to": to, "subject": subject, "text": text}
        # 429 and 5xx are retried with the same key: Resend returns the first email instead of a second.
        for attempt in range(3):
            r = self._http.post(f"{self.base_url}/emails", headers=headers, json=body)
            if (r.status_code == 429 or r.status_code >= 500) and attempt < 2:
                time.sleep(min(float(r.headers.get("Retry-After", "1")), 10.0))
                continue
            break
        if r.status_code >= 300:
            raise ResendError(f"POST /emails: HTTP {r.status_code} {r.text[:300]}", r.status_code)
        data = r.json()
        if not data.get("id"):
            raise ResendError("POST /emails returned no id")
        return data

    def get_email(self, email_id: str) -> dict[str, Any]:
        r = self._http.get(f"{self.base_url}/emails/{email_id}", headers=self.headers)
        if r.status_code >= 300:
            raise ResendError(f"GET /emails/{email_id}: HTTP {r.status_code} {r.text[:300]}", r.status_code)
        return r.json()
