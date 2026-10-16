"""AWS Lambda: run a single named agent for Step Functions Task states."""

from __future__ import annotations

from typing import Any

from customer_ops.orchestrator import run_single_agent
from customer_ops.store import get_store


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    """
    Input:
      {
        "workflow_id": "wf_...",
        "agent": "research" | "quote" | "billing" | "handoff" | "survey",
        "request": {...}   # optional seed if record missing
      }
    """
    workflow_id = event["workflow_id"]
    agent = event["agent"]

    # Ensure request payload is on the record (first task may seed)
    store = get_store()
    record = store.get(workflow_id)
    if record is None and event.get("request"):
        from customer_ops.models import WorkflowRecord, WorkflowRequest

        req = WorkflowRequest.model_validate(event["request"])
        record = WorkflowRecord(
            workflow_id=workflow_id,
            request=req,
            idempotency_key=event.get("idempotency_key") or req.resolve_idempotency_key(),
        )
        try:
            store.claim(record, lease_owner="agent-runner")
        except Exception:
            record = store.get(workflow_id)

    result = run_single_agent(agent, workflow_id, store=store)
    return {
        "workflow_id": workflow_id,
        "agent": agent,
        "status": result.status.value,
        "output": result.output,
        "error": result.error.model_dump() if result.error else None,
    }
