r"""Drop a test email into the inbox via Gmail messages.insert.

Simulates mail arriving, without sending anything. Works against real Gmail
(needs the gmail.insert scope) or any Gmail-compatible test twin.

  python scripts/insert_test_email.py --from "Disney+ <disneyplus@mail.disneyplus.com>" \
      --subject "Your Disney+ subscription receipt" \
      --body "You were charged $13.99. Your subscription renews on November 20, 2026."
"""

from __future__ import annotations

import argparse
import base64
import email.utils
import json
import os
import uuid

import httpx


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--from", dest="sender", required=True)
    p.add_argument("--subject", required=True)
    p.add_argument("--body", required=True)
    a = p.parse_args()

    msg = (
        f"From: {a.sender}\r\nTo: me@example.test\r\nSubject: {a.subject}\r\n"
        f"Date: {email.utils.formatdate(usegmt=True)}\r\n"
        f"Message-ID: <{uuid.uuid4()}@subwatch.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{a.body}\r\n"
    )
    raw = base64.urlsafe_b64encode(msg.encode()).decode().rstrip("=")
    base = os.environ.get("GMAIL_BASE_URL", "https://gmail.googleapis.com").rstrip("/")
    headers = {"Authorization": f"Bearer {os.environ['GOOGLE_ACCESS_TOKEN']}"}
    r = httpx.post(f"{base}/gmail/v1/users/me/messages", headers=headers,
                   json={"raw": raw, "labelIds": ["INBOX", "UNREAD"]}, timeout=15)
    r.raise_for_status()
    print(json.dumps({"id": r.json()["id"], "subject": a.subject}))


if __name__ == "__main__":
    main()
