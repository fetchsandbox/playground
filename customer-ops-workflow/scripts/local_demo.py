#!/usr/bin/env python3
"""Run a sample Slack-style workflow locally and print the agent fan-out."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from customer_ops.models import SlackTrigger, WorkflowRequest
from customer_ops.orchestrator import Orchestrator
from customer_ops.store import InMemoryWorkflowStore, reset_store_for_tests


def main() -> int:
    store = reset_store_for_tests(InMemoryWorkflowStore())
    orch = Orchestrator(store=store, lease_owner="demo")
    record = orch.start(
        WorkflowRequest(
            customer_email="ada@acme.com",
            customer_name="Ada Lovelace",
            company="Acme Analytics",
            sku="pro_annual",
            quantity=3,
            slack=SlackTrigger(
                event_id="EvDemo001",
                channel_id="C_DEMO",
                user_id="U_DEMO",
                text="/customer-ops email=ada@acme.com qty=3",
                thread_ts="1700000000.000100",
            ),
        )
    )
    print(json.dumps(
        {
            "workflow_id": record.workflow_id,
            "status": record.status.value,
            "summary": record.summary,
            "agents": {
                k: {"status": v.status.value, "output": v.output}
                for k, v in record.agent_results.items()
            },
            "integration_calls": [
                {"service": c.service, "operation": c.operation, "idem": c.idempotency_key}
                for c in orch.bus.calls
            ],
        },
        indent=2,
        default=str,
    ))
    return 0 if record.status.value == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
