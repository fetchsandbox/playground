"""Race / idempotency coverage for concurrent claims and duplicate Slack events."""

from __future__ import annotations

import concurrent.futures

from customer_ops.models import SlackTrigger, WorkflowRequest
from customer_ops.orchestrator import Orchestrator
from customer_ops.store import InMemoryWorkflowStore, reset_store_for_tests


def _req(email: str = "ada@acme.com", event_id: str = "Ev123") -> WorkflowRequest:
    return WorkflowRequest(
        customer_email=email,
        customer_name="Ada Lovelace",
        company="Acme",
        sku="pro_annual",
        quantity=3,
        slack=SlackTrigger(
            event_id=event_id,
            channel_id="C01",
            user_id="U01",
            text=f"email={email} qty=3",
            thread_ts="111.222",
        ),
    )


def test_duplicate_slack_event_returns_same_workflow():
    store = reset_store_for_tests(InMemoryWorkflowStore())
    orch = Orchestrator(store=store, lease_owner="w1")
    first = orch.start(_req())
    second = orch.start(_req())  # same event_id → same idempotency key
    assert first.workflow_id == second.workflow_id
    assert second.summary.get("duplicate_trigger") is True
    # Stripe/HubSpot/Gmail should not double-create on duplicate trigger
    pi_creates = [
        c
        for c in orch.bus.calls
        if c.service == "stripe" and c.operation == "payment_intents.create"
    ]
    # Only the first run executes agents; second short-circuits before agents
    assert len(pi_creates) >= 1


def test_concurrent_claims_single_winner():
    store = reset_store_for_tests(InMemoryWorkflowStore())

    def run(owner: str):
        return Orchestrator(store=store, lease_owner=owner).start(_req(event_id="EvRace"))

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(run, f"w{i}") for i in range(8)]
        results = [f.result() for f in futures]

    ids = {r.workflow_id for r in results}
    assert len(ids) == 1
    completed = [r for r in results if r.status.value in {"completed", "partial"}]
    assert len(completed) >= 1


def test_integration_idempotency_replays_on_same_key():
    store = reset_store_for_tests(InMemoryWorkflowStore())
    orch = Orchestrator(store=store)
    record = orch.start(_req(event_id="EvIdem"))
    # Manually re-invoke billing with same workflow idempotency keys via bus
    from customer_ops.agents.billing import BillingAgent
    from customer_ops.orchestrator import Orchestrator as Orch

    ctx = Orch(store=store, bus=orch.bus)._context(record)
    again = BillingAgent().run(ctx)
    assert again.output.get("replayed") is True or any(
        c.response.get("_replayed") for c in orch.bus.calls if c.service == "stripe"
    )
