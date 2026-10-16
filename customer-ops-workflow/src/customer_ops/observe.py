"""Keyed observation state for FetchSandbox application_workflow_v1 selectors."""

from __future__ import annotations

import threading
from typing import Any

_lock = threading.RLock()
_workflows: list[dict[str, Any]] = []
_runs: dict[str, list[dict[str, Any]]] = {}
_cases: dict[str, list[dict[str, Any]]] = {}
_webhooks: list[dict[str, Any]] = []
_case_webhooks: dict[str, list[dict[str, Any]]] = {}


def _case_key(run_id: str | None, case_id: str | None) -> str | None:
    if not run_id or not case_id:
        return None
    return f"{run_id}::{case_id}"


def reset() -> None:
    with _lock:
        _workflows.clear()
        _runs.clear()
        _cases.clear()
        _webhooks.clear()
        _case_webhooks.clear()


def push_workflow(summary: dict[str, Any], *, run_id: str | None, case_id: str | None) -> None:
    with _lock:
        _workflows.append(summary)
        if run_id:
            _runs.setdefault(str(run_id), []).append(summary)
        ck = _case_key(run_id, case_id)
        if ck:
            _cases.setdefault(ck, []).append(summary)


def push_webhook(entry: dict[str, Any]) -> None:
    with _lock:
        _webhooks.append(entry)
        ck = _case_key(entry.get("runId"), entry.get("caseId"))
        if ck:
            _case_webhooks.setdefault(ck, []).append(entry)


def list_workflows(*, run_id: str | None = None, case_id: str | None = None) -> list[dict[str, Any]]:
    with _lock:
        ck = _case_key(run_id, case_id)
        if ck:
            return list(_cases.get(ck, []))
        if run_id:
            return list(_runs.get(str(run_id), []))
        return list(_workflows)


def list_webhooks(*, run_id: str | None = None, case_id: str | None = None) -> list[dict[str, Any]]:
    with _lock:
        ck = _case_key(run_id, case_id)
        if ck:
            return list(_case_webhooks.get(ck, []))
        if run_id:
            return [w for w in _webhooks if w.get("runId") == run_id or not w.get("runId")]
        return list(_webhooks)


def webhook_seen(provider: str, event_id: str | None) -> bool:
    if not event_id:
        return False
    with _lock:
        return any(
            w.get("provider") == provider and w.get("eventId") == event_id for w in _webhooks
        )
