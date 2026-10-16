"""Survey agent — post-handoff CSAT email via Gmail."""

from __future__ import annotations

from customer_ops.agents.base import AgentContext
from customer_ops.models import AgentName, AgentResult, AgentStatus


class SurveyAgent:
    name = AgentName.SURVEY

    def run(self, ctx: AgentContext) -> AgentResult:
        req = ctx.workflow.request
        wf = ctx.workflow.workflow_id
        handoff = ctx.prior_output(AgentName.HANDOFF)
        name = req.customer_name or "there"
        body = (
            f"Hi {name},\n\n"
            "Thanks for requesting a quote. Your account executive has been notified.\n"
            f"Reference: {wf} / deal {handoff.get('hubspot_deal_id', 'pending')}.\n\n"
            "Quick pulse (1–5): How easy was this request?\n"
            "Reply to this email with a number — it helps us improve onboarding.\n\n"
            "— Customer Ops\n"
        )
        sent = ctx.gmail.send(
            to=req.customer_email,
            subject="How was your quote experience?",
            body=body,
            idempotency_key=f"{wf}:gmail:survey",
        )
        return AgentResult(agent=self.name, status=AgentStatus.SUCCEEDED).succeed(
            {
                "message_id": sent["id"],
                "thread_id": sent.get("threadId"),
                "to": req.customer_email,
            }
        )
