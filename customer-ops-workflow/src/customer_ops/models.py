"""Shared domain models for the customer-ops multi-agent workflow."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


class AgentName(str, Enum):
    RESEARCH = "research"
    QUOTE = "quote"
    BILLING = "billing"
    HANDOFF = "handoff"
    SURVEY = "survey"


class WorkflowStatus(str, Enum):
    CLAIMED = "claimed"
    RUNNING = "running"
    PARTIAL = "partial"  # some agents failed; recoverable results kept
    COMPLETED = "completed"
    FAILED = "failed"
    DUPLICATE = "duplicate"


class AgentStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    SKIPPED = "skipped"


class SlackTrigger(BaseModel):
    """Inbound Slack slash-command / mention payload (normalized)."""

    event_id: str
    team_id: str = "T_LOCAL"
    channel_id: str
    user_id: str
    thread_ts: str | None = None
    text: str
    response_url: str | None = None


class WorkflowRequest(BaseModel):
    """Canonical request parsed from Slack text or HTTP body."""

    customer_email: str
    customer_name: str | None = None
    company: str | None = None
    sku: str = "pro_annual"
    quantity: int = 1
    notes: str | None = None
    slack: SlackTrigger | None = None
    correlation_id: str = Field(default_factory=lambda: new_id("corr"))
    idempotency_key: str | None = None

    def resolve_idempotency_key(self) -> str:
        if self.idempotency_key:
            return self.idempotency_key
        if self.slack:
            return f"slack:{self.slack.event_id}"
        return f"corr:{self.correlation_id}"


class AgentError(BaseModel):
    code: str
    message: str
    retryable: bool = False
    details: dict[str, Any] = Field(default_factory=dict)


class AgentResult(BaseModel):
    agent: AgentName
    status: AgentStatus
    started_at: datetime = Field(default_factory=utcnow)
    finished_at: datetime | None = None
    output: dict[str, Any] = Field(default_factory=dict)
    error: AgentError | None = None
    attempts: int = 1

    def succeed(self, output: dict[str, Any]) -> AgentResult:
        return self.model_copy(
            update={
                "status": AgentStatus.SUCCEEDED,
                "output": output,
                "finished_at": utcnow(),
                "error": None,
            }
        )

    def fail(self, error: AgentError) -> AgentResult:
        return self.model_copy(
            update={
                "status": AgentStatus.FAILED,
                "error": error,
                "finished_at": utcnow(),
            }
        )


class WorkflowRecord(BaseModel):
    workflow_id: str = Field(default_factory=lambda: new_id("wf"))
    status: WorkflowStatus = WorkflowStatus.CLAIMED
    request: WorkflowRequest
    idempotency_key: str
    lease_owner: str | None = None
    lease_until: datetime | None = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    agent_results: dict[str, AgentResult] = Field(default_factory=dict)
    summary: dict[str, Any] = Field(default_factory=dict)
    errors: list[AgentError] = Field(default_factory=list)

    def touch(self) -> None:
        self.updated_at = utcnow()
