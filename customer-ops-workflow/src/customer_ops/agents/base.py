"""Agent protocol + error-scope wrapper."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from customer_ops.integrations.base import IntegrationBus
from customer_ops.integrations.gmail_api import GmailClient
from customer_ops.integrations.hubspot_api import HubSpotClient
from customer_ops.integrations.slack_api import SlackClient
from customer_ops.integrations.stripe_api import StripeClient
from customer_ops.models import (
    AgentError,
    AgentName,
    AgentResult,
    AgentStatus,
    WorkflowRecord,
)


@dataclass
class AgentContext:
    workflow: WorkflowRecord
    bus: IntegrationBus
    stripe: StripeClient
    hubspot: HubSpotClient
    gmail: GmailClient
    slack: SlackClient
    prior: dict[str, AgentResult] = field(default_factory=dict)

    def prior_output(self, name: AgentName) -> dict[str, Any]:
        result = self.prior.get(name.value)
        if not result or result.status != AgentStatus.SUCCEEDED:
            return {}
        return result.output


class Agent(Protocol):
    name: AgentName

    def run(self, ctx: AgentContext) -> AgentResult: ...


def run_with_scope(agent: Agent, ctx: AgentContext) -> AgentResult:
    """Isolate agent failures so parallel siblings keep their results."""
    started = AgentResult(agent=agent.name, status=AgentStatus.RUNNING)
    try:
        result = agent.run(ctx)
        if result.status == AgentStatus.RUNNING:
            return result.succeed(result.output)
        return result
    except Exception as exc:  # noqa: BLE001 — intentional scope boundary
        return started.fail(
            AgentError(
                code="agent_uncaught",
                message=str(exc),
                retryable=_is_retryable(exc),
                details={"agent": agent.name.value, "type": type(exc).__name__},
            )
        )


def _is_retryable(exc: Exception) -> bool:
    name = type(exc).__name__.lower()
    text = str(exc).lower()
    return any(
        token in name or token in text
        for token in ("timeout", "temporar", "rate", "429", "503", "connection")
    )


SKU_PRICES_CENTS = {
    "starter_monthly": 2900,
    "pro_annual": 99000,
    "enterprise": 499000,
}
