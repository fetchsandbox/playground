"""One entry point shared by the local server and the Lambda handler."""

from __future__ import annotations

import base64
import hmac
import json
import threading
from dataclasses import asdict
from typing import Any

from .config import Settings
from .processor import build_clients, run_once
from .rules import load_rules
from .store import Store

# One run at a time per process; Lambda additionally caps concurrency at 1.
_run_lock = threading.Lock()


def run(settings: Settings, store: Store) -> dict[str, Any]:
    ruleset = load_rules(settings.rules_path)
    with _run_lock:
        clients = build_clients(settings)
        try:
            report = run_once(settings, store, ruleset, clients)
        finally:
            clients.close()
    return asdict(report)


def push_authorized(settings: Settings, token: str | None) -> bool:
    if not settings.push_token:
        return False
    return token is not None and hmac.compare_digest(token, settings.push_token)


def describe_push(body: dict[str, Any]) -> dict[str, Any]:
    """Decode a Gmail Pub/Sub push envelope (for logs only).

    Gmail's notification carries just {emailAddress, historyId}; the run
    re-reads the inbox, so a lost or duplicated push changes nothing.
    """
    data = (body.get("message") or {}).get("data")
    if not data:
        return {}
    try:
        return json.loads(base64.b64decode(data))
    except ValueError:
        return {}
