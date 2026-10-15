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


def push_token(path_token: str | None, query_token: str | None, authorization: str | None) -> str | None:
    """The token a push request presents.

    A token in the path (/gmail/push/<token>) is authoritative when present;
    otherwise ?token= or an `Authorization: Bearer` header is accepted.
    """
    if path_token is not None:
        return path_token
    if query_token is not None:
        return query_token
    if authorization and authorization.startswith("Bearer "):
        return authorization[len("Bearer "):]
    return None


def describe_push(raw: bytes | str) -> dict[str, Any]:
    """Decode a Gmail Pub/Sub push envelope, for logs only.

    Gmail's notification carries just {emailAddress, historyId}; every run
    re-reads the inbox, so the payload is never trusted. Anything malformed is
    reported, not raised: a non-2xx answer would make Pub/Sub redeliver the
    same garbage indefinitely.
    """
    try:
        body = json.loads(raw or "{}")
    except ValueError:
        return {"malformed": "body is not JSON"}
    message = body.get("message") if isinstance(body, dict) else None
    data = message.get("data") if isinstance(message, dict) else None
    if not isinstance(data, str) or not data:
        return {"malformed": "no message.data"}
    try:
        decoded = json.loads(base64.b64decode(data, validate=True))
    except (ValueError, TypeError):
        return {"malformed": "message.data is not base64 JSON"}
    return decoded if isinstance(decoded, dict) else {"malformed": "message.data is not an object"}
