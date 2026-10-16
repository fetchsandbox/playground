"""Orchestrates parallel agents with error scopes and race-safe claims.

Wave layout (mirrors the AWS Step Functions state machine):

  Claim
    → Wave A (parallel): Research ‖ Billing-prep is deferred
    → Wave B (parallel): Quote (needs Research) ‖ Billing (can use Quote if ready)
    → Wave C (sequential-ish): Handoff → Survey

Locally we run:
  1) Research
  2) Parallel: Quote + Billing  (Billing reads Quote when available; else SKU fallback)
  3) Handoff
  4) Survey

Each agent runs inside `run_with_scope` so one failure cannot tear down siblings.
Idempotent integration keys + store.claim prevent duplicate Stripe/HubSpot/Gmail
writes when Slack retries or two workers race.
"""

from __future__ import annotations

import concurrent.futures
import os
from typing import Callable

from customer_ops.agents.base import Agent, AgentContext, run_with_scope
from customer_ops.agents.billing import BillingAgent
from customer_ops.agents.handoff import HandoffAgent
from customer_ops.agents.quote import QuoteAgent
from customer_ops.agents.research import ResearchAgent
from customer_ops.agents.survey import SurveyAgent
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
    WorkflowRequest,
    WorkflowStatus,
)
from customer_ops.store import ClaimConflict, WorkflowStore, get_store


class Orchestrator:
    def __init__(
        self,
        store: WorkflowStore | None = None,
        *,
        lease_owner: str | None = None,
        bus: IntegrationBus | None = None,
        max_workers: int = 4,
    ):
        self.store = store or get_store()
        self.lease_owner = lease_owner or f"worker-{os.getpid()}"
        self.bus = bus or IntegrationBus()
        self.max_workers = max_workers
        self.stripe = StripeClient(self.bus)
        self.hubspot = HubSpotClient(self.bus)
        self.gmail = GmailClient(self.bus)
        self.slack = SlackClient(self.bus)

    def start(self, request: WorkflowRequest) -> WorkflowRecord:
        """Claim + run the full workflow. Safe under concurrent duplicate triggers."""
        idem = request.resolve_idempotency_key()
        record = WorkflowRecord(request=request, idempotency_key=idem)
        try:
            claimed = self.store.claim(record, lease_owner=self.lease_owner)
        except ClaimConflict as conflict:
            existing = conflict.existing
            # Return the winner's record; mark duplicate for callers that care.
            if existing.status in {WorkflowStatus.COMPLETED, WorkflowStatus.RUNNING, WorkflowStatus.PARTIAL, WorkflowStatus.CLAIMED}:
                dup = existing.model_copy(deep=True)
                if dup.status != WorkflowStatus.DUPLICATE:
                    # Do not mutate persisted status — surface via summary only.
                    dup.summary = {**dup.summary, "duplicate_trigger": True}
                return dup
            raise

        return self._execute(claimed)

    def _execute(self, record: WorkflowRecord) -> WorkflowRecord:
        expected = record.updated_at
        record.status = WorkflowStatus.RUNNING
        record = self.store.save(record, expected_updated_at=expected)

        ctx = self._context(record)

        # Wave 1 — research (foundation)
        research = self._run_one(ResearchAgent(), ctx)
        record = self._persist_result(record, research)
        ctx = self._context(record)

        # Wave 2 — quote + billing in parallel
        quote_agent = QuoteAgent()
        billing_agent = BillingAgent()
        parallel_results = self._run_parallel(
            [quote_agent, billing_agent],
            ctx,
            # Billing may start before quote finishes; QuoteAgent only needs research.
            # Re-bind context per future so Billing sees Quote when both finish together
            # via a second pass if needed.
        )
        for result in parallel_results:
            record = self._persist_result(record, result)
        ctx = self._context(record)

        # If billing ran without quote (timing), re-run billing once with quote present.
        billing = record.agent_results.get(AgentName.BILLING.value)
        quote = record.agent_results.get(AgentName.QUOTE.value)
        if (
            quote
            and quote.status == AgentStatus.SUCCEEDED
            and billing
            and billing.status == AgentStatus.SUCCEEDED
            and not billing.output.get("invoice_id")
        ):
            billing2 = self._run_one(BillingAgent(), ctx)
            record = self._persist_result(record, billing2)
            ctx = self._context(record)

        # If parallel billing used SKU fallback while quote later succeeded with discount,
        # prefer a fresh billing when amounts diverge and prior billing was not replayed.
        if (
            quote
            and quote.status == AgentStatus.SUCCEEDED
            and billing
            and billing.status == AgentStatus.SUCCEEDED
            and quote.output.get("total_cents") is not None
            and billing.output.get("amount_due") != quote.output.get("total_cents")
            and not billing.output.get("replayed")
        ):
            billing2 = self._run_one(BillingAgent(), ctx)
            record = self._persist_result(record, billing2)
            ctx = self._context(record)

        # Wave 3 — handoff then survey (survey needs handoff deal id for copy)
        handoff = self._run_one(HandoffAgent(), ctx)
        record = self._persist_result(record, handoff)
        ctx = self._context(record)

        survey = self._run_one(SurveyAgent(), ctx)
        record = self._persist_result(record, survey)

        record = self._finalize(record)
        return record

    def _context(self, record: WorkflowRecord) -> AgentContext:
        return AgentContext(
            workflow=record,
            bus=self.bus,
            stripe=self.stripe,
            hubspot=self.hubspot,
            gmail=self.gmail,
            slack=self.slack,
            prior=dict(record.agent_results),
        )

    def _run_one(self, agent: Agent, ctx: AgentContext) -> AgentResult:
        return run_with_scope(agent, ctx)

    def _run_parallel(self, agents: list[Agent], ctx: AgentContext) -> list[AgentResult]:
        results: list[AgentResult] = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=self.max_workers) as pool:
            futures = {pool.submit(run_with_scope, agent, ctx): agent for agent in agents}
            for fut in concurrent.futures.as_completed(futures):
                results.append(fut.result())
        # Stable order for determinism in tests
        order = {a.name: i for i, a in enumerate(agents)}
        results.sort(key=lambda r: order.get(r.agent, 99))
        return results

    def _persist_result(self, record: WorkflowRecord, result: AgentResult) -> WorkflowRecord:
        expected = record.updated_at
        record.agent_results[result.agent.value] = result
        if result.status == AgentStatus.FAILED and result.error:
            record.errors.append(result.error)
        try:
            return self.store.save(record, expected_updated_at=expected)
        except ClaimConflict:
            # Lost an optimistic lock — reload and merge this agent result.
            fresh = self.store.get(record.workflow_id)
            if fresh is None:
                raise
            fresh.agent_results[result.agent.value] = result
            if result.status == AgentStatus.FAILED and result.error:
                fresh.errors.append(result.error)
            return self.store.save(fresh)

    def _finalize(self, record: WorkflowRecord) -> WorkflowRecord:
        expected = record.updated_at
        statuses = [r.status for r in record.agent_results.values()]
        if statuses and all(s == AgentStatus.SUCCEEDED for s in statuses):
            record.status = WorkflowStatus.COMPLETED
        elif any(s == AgentStatus.SUCCEEDED for s in statuses):
            record.status = WorkflowStatus.PARTIAL
        else:
            record.status = WorkflowStatus.FAILED

        record.summary = {
            "workflow_id": record.workflow_id,
            "customer_email": record.request.customer_email,
            "agents": {
                name: {
                    "status": res.status.value,
                    "error": res.error.model_dump() if res.error else None,
                    "keys": sorted(res.output.keys()),
                }
                for name, res in record.agent_results.items()
            },
            "integration_calls": len(self.bus.calls),
        }

        # Slack completion ping (best-effort; scoped)
        if record.request.slack:
            try:
                emoji = "✅" if record.status == WorkflowStatus.COMPLETED else "⚠️"
                self.slack.post_message(
                    channel=record.request.slack.channel_id,
                    text=f"{emoji} Workflow `{record.workflow_id}` → *{record.status.value}*",
                    thread_ts=record.request.slack.thread_ts,
                    idempotency_key=f"{record.workflow_id}:slack:complete",
                )
            except Exception as exc:  # noqa: BLE001
                record.errors.append(
                    AgentError(code="slack_complete_failed", message=str(exc), retryable=True)
                )

        return self.store.save(record, expected_updated_at=expected)


def parse_slack_text(text: str) -> dict:
    """Parse `/customer-ops quote email=a@b.com name=Ada company=Acme sku=pro_annual qty=2`.

    Also accepts freeform: `quote for Ada <ada@acme.com> Acme pro_annual`.
    """
    cleaned = text.strip()
    for prefix in ("/customer-ops", "customer-ops", "<@"):
        if cleaned.lower().startswith("/customer-ops"):
            cleaned = cleaned.split(None, 1)[1] if " " in cleaned else ""
            break
    # Strip leading bot mention <@U123>
    if cleaned.startswith("<@"):
        cleaned = cleaned.split(">", 1)[-1].strip()

    fields: dict[str, str] = {}
    tokens = cleaned.split()
    leftover: list[str] = []
    for tok in tokens:
        if "=" in tok:
            k, _, v = tok.partition("=")
            fields[k.lower()] = v.strip("<>")
        else:
            leftover.append(tok)

    email = fields.get("email")
    if not email:
        for tok in leftover:
            if "@" in tok:
                email = tok.strip("<>")
                break
    if not email:
        raise ValueError(
            "Missing customer email. Example: `/customer-ops email=ada@acme.com company=Acme sku=pro_annual`"
        )

    name = fields.get("name")
    company = fields.get("company")
    sku = fields.get("sku", "pro_annual")
    qty = int(fields.get("qty") or fields.get("quantity") or "1")
    notes = fields.get("notes") or (" ".join(leftover) if leftover else None)

    return {
        "customer_email": email,
        "customer_name": name,
        "company": company,
        "sku": sku,
        "quantity": qty,
        "notes": notes,
    }


# Lambda-friendly single-agent entry (Step Functions Task states)
AGENT_FACTORY: dict[str, Callable[[], Agent]] = {
    AgentName.RESEARCH.value: ResearchAgent,
    AgentName.QUOTE.value: QuoteAgent,
    AgentName.BILLING.value: BillingAgent,
    AgentName.HANDOFF.value: HandoffAgent,
    AgentName.SURVEY.value: SurveyAgent,
}


def run_single_agent(agent_name: str, workflow_id: str, store: WorkflowStore | None = None) -> AgentResult:
    store = store or get_store()
    record = store.get(workflow_id)
    if record is None:
        raise KeyError(workflow_id)
    orch = Orchestrator(store=store)
    ctx = orch._context(record)
    agent = AGENT_FACTORY[agent_name]()
    result = run_with_scope(agent, ctx)
    orch._persist_result(record, result)
    return result
