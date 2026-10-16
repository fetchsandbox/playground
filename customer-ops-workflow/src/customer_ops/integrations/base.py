"""Integration clients: real HTTP when twin/live keys present, else mocks."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any


@dataclass
class IntegrationCallLog:
    service: str
    operation: str
    request: dict[str, Any]
    response: dict[str, Any]
    idempotency_key: str | None = None


@dataclass
class IntegrationBus:
    """Shared call log + idempotent response cache for race-safe mocks."""

    calls: list[IntegrationCallLog] = field(default_factory=list)
    _idem_cache: dict[str, dict[str, Any]] = field(default_factory=dict)

    def remember(
        self,
        *,
        service: str,
        operation: str,
        request: dict[str, Any],
        response: dict[str, Any],
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        if idempotency_key:
            cache_key = f"{service}:{operation}:{idempotency_key}"
            if cache_key in self._idem_cache:
                cached = self._idem_cache[cache_key]
                self.calls.append(
                    IntegrationCallLog(
                        service=service,
                        operation=operation,
                        request=request,
                        response={**cached, "_replayed": True},
                        idempotency_key=idempotency_key,
                    )
                )
                return {**cached, "_replayed": True}
            self._idem_cache[cache_key] = response
        self.calls.append(
            IntegrationCallLog(
                service=service,
                operation=operation,
                request=request,
                response=response,
                idempotency_key=idempotency_key,
            )
        )
        return response


def env(*names: str, default: str | None = None) -> str | None:
    for name in names:
        val = os.environ.get(name)
        if val:
            return val
    return default


def twin_bases_configured() -> bool:
    """True when FetchSandbox twin (or any override) base URLs are injected."""
    return any(
        os.environ.get(k)
        for k in (
            "STRIPE_API_BASE",
            "STRIPE_BASE_URL",
            "HUBSPOT_API_BASE",
            "HUBSPOT_BASE_URL",
            "GMAIL_API_BASE",
            "GMAIL_BASE_URL",
            "SLACK_API_BASE",
            "SLACK_BASE_URL",
        )
    )


def use_mocks() -> bool:
    """Mocks unless explicitly disabled or twin bases are present."""
    flag = os.environ.get("CUSTOMER_OPS_USE_MOCKS")
    if flag is not None:
        return flag not in {"0", "false", "False"}
    # Auto-live against twins when bases are handed off by FetchSandbox.
    return not twin_bases_configured()


def join_base(base: str, path: str) -> str:
    """Join twin base (…/sandbox/<id>) with a vendor path without dropping the sandbox prefix."""
    return f"{base.rstrip('/')}/{path.lstrip('/')}"


def flow_headers() -> dict[str, str]:
    headers: dict[str, str] = {"User-Agent": "customer-ops-workflow/0.1"}
    run_id = os.environ.get("X_FLOW_RUN_ID") or os.environ.get("FETCHSANDBOX_FLOW_RUN_ID")
    if run_id:
        headers["X-Flow-Run-Id"] = run_id
    return headers
