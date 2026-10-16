"""AWS Lambda: merge agent outcomes + Slack completion notice."""

from __future__ import annotations

from typing import Any

from customer_ops.integrations.slack_api import SlackClient
from customer_ops.models import AgentError, AgentStatus, WorkflowStatus
from customer_ops.store import get_store


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    workflow_id = event["workflow_id"]
    store = get_store()
    record = store.get(workflow_id)
    if record is None:
        return {"ok": False, "error": "missing_workflow"}

    statuses = [r.status for r in record.agent_results.values()]
    if statuses and all(s == AgentStatus.SUCCEEDED for s in statuses):
        record.status = WorkflowStatus.COMPLETED
    elif any(s == AgentStatus.SUCCEEDED for s in statuses):
        record.status = WorkflowStatus.PARTIAL
    else:
        record.status = WorkflowStatus.FAILED

    # Attach any Step Functions catch payload
    if event.get("error"):
        record.errors.append(
            AgentError(
                code=str(event["error"].get("Error", "sfn_error")),
                message=str(event["error"].get("Cause", "unknown")),
                retryable=True,
            )
        )

    record.summary = {
        **record.summary,
        "workflow_id": record.workflow_id,
        "final_status": record.status.value,
        "agents": {k: v.status.value for k, v in record.agent_results.items()},
    }
    store.save(record)

    if record.request.slack:
        emoji = "✅" if record.status == WorkflowStatus.COMPLETED else "⚠️"
        try:
            SlackClient().post_message(
                channel=record.request.slack.channel_id,
                text=f"{emoji} Workflow `{record.workflow_id}` → *{record.status.value}*",
                thread_ts=record.request.slack.thread_ts,
                idempotency_key=f"{record.workflow_id}:slack:complete",
            )
        except Exception as exc:  # noqa: BLE001
            record.errors.append(
                AgentError(code="slack_complete_failed", message=str(exc), retryable=True)
            )
            store.save(record)

    return {"ok": True, "status": record.status.value, "summary": record.summary}
