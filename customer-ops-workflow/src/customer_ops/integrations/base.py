"""Integration clients: real HTTP when keys present, otherwise deterministic mocks."""

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


def use_mocks() -> bool:
    return os.environ.get("CUSTOMER_OPS_USE_MOCKS", "1") not in {"0", "false", "False"}


def env(*names: str, default: str | None = None) -> str | None:
    for name in names:
        val = os.environ.get(name)
        if val:
            return val
    return default
