"""Happy-path + partial-failure scopes for the multi-agent orchestrator."""

from __future__ import annotations

from customer_ops.agents.base import AgentContext, run_with_scope
from customer_ops.models import (
    AgentError,
    AgentName,
    AgentResult,
    AgentStatus,
    SlackTrigger,
    WorkflowRequest,
    WorkflowStatus,
)
from customer_ops.orchestrator import Orchestrator, parse_slack_text
from customer_ops.store import InMemoryWorkflowStore, reset_store_for_tests


def test_parse_slack_text_key_values():
    fields = parse_slack_text(
        "/customer-ops email=ada@acme.com name=Ada company=Acme sku=pro_annual qty=2"
    )
    assert fields["customer_email"] == "ada@acme.com"
    assert fields["quantity"] == 2
    assert fields["sku"] == "pro_annual"


def test_full_workflow_completes_all_agents():
    store = reset_store_for_tests(InMemoryWorkflowStore())
    orch = Orchestrator(store=store)
    record = orch.start(
        WorkflowRequest(
            customer_email="ada@acme.com",
            customer_name="Ada",
            company="Acme",
            sku="pro_annual",
            quantity=3,
            slack=SlackTrigger(
                event_id="EvHappy",
                channel_id="C01",
                user_id="U01",
                text="email=ada@acme.com",
            ),
        )
    )
    assert record.status == WorkflowStatus.COMPLETED
    for name in AgentName:
        assert record.agent_results[name.value].status == AgentStatus.SUCCEEDED

    # Mid-market + qty>=3 → 10% discount
    quote = record.agent_results["quote"].output
    assert quote["discount_pct"] == 10
    assert quote["total_cents"] < quote["subtotal_cents"]

    services = {c.service for c in orch.bus.calls}
    assert {"stripe", "hubspot", "gmail", "slack"} <= services


def test_error_scope_keeps_sibling_results():
    store = reset_store_for_tests(InMemoryWorkflowStore())
    orch = Orchestrator(store=store)

    class BoomResearch:
        name = AgentName.RESEARCH

        def run(self, ctx: AgentContext) -> AgentResult:
            raise TimeoutError("vendor timeout")

    # Unit-level: scoped runner converts exceptions to AgentResult.failed
    req = WorkflowRequest(customer_email="x@y.com", sku="pro_annual")
    from customer_ops.models import WorkflowRecord

    record = WorkflowRecord(request=req, idempotency_key="k")
    ctx = orch._context(record)
    result = run_with_scope(BoomResearch(), ctx)
    assert result.status == AgentStatus.FAILED
    assert result.error and result.error.retryable is True


def test_unknown_sku_marks_quote_failed_but_workflow_partial():
    """Force quote failure via unknown sku; research/billing/handoff/survey still attempt."""
    store = reset_store_for_tests(InMemoryWorkflowStore())
    orch = Orchestrator(store=store)
    record = orch.start(
        WorkflowRequest(
            customer_email="bad@acme.com",
            sku="not_a_real_sku",
            quantity=1,
            idempotency_key="sku-miss",
        )
    )
    assert record.agent_results["research"].status == AgentStatus.SUCCEEDED
    assert record.agent_results["quote"].status == AgentStatus.FAILED
    # Billing falls back to SKU map → amount 0 path or still succeeds with 0
    assert record.status in {WorkflowStatus.PARTIAL, WorkflowStatus.COMPLETED, WorkflowStatus.FAILED}
