"""Customer handoff agent — HubSpot deal + Slack summary for AE."""

from __future__ import annotations

from customer_ops.agents.base import AgentContext
from customer_ops.models import AgentName, AgentResult, AgentStatus


class HandoffAgent:
    name = AgentName.HANDOFF

    def run(self, ctx: AgentContext) -> AgentResult:
        req = ctx.workflow.request
        wf = ctx.workflow.workflow_id
        research = ctx.prior_output(AgentName.RESEARCH)
        quote = ctx.prior_output(AgentName.QUOTE)
        billing = ctx.prior_output(AgentName.BILLING)

        contact = ctx.hubspot.upsert_contact(
            email=req.customer_email,
            name=req.customer_name,
            company=research.get("company") or req.company,
            idempotency_key=f"{wf}:hubspot:contact",
        )
        amount_dollars = (quote.get("total_cents") or billing.get("amount_due") or 0) / 100.0
        deal = ctx.hubspot.create_deal(
            dealname=f"{research.get('company') or req.customer_email} — {quote.get('sku', req.sku)}",
            amount=amount_dollars,
            contact_id=str(contact["id"]),
            idempotency_key=f"{wf}:hubspot:deal",
        )

        channel = req.slack.channel_id if req.slack else "C_LOCAL"
        thread_ts = req.slack.thread_ts if req.slack else None
        summary = (
            f"*Customer handoff* `{wf}`\n"
            f"• Contact: {req.customer_name or '—'} <{req.customer_email}>\n"
            f"• Company: {research.get('company') or req.company or '—'}\n"
            f"• Quote: {quote.get('sku')} x{quote.get('quantity')} = "
            f"${amount_dollars:,.2f}\n"
            f"• Stripe invoice: `{billing.get('invoice_id', 'n/a')}`\n"
            f"• HubSpot deal: `{deal.get('id')}`\n"
            f"• AE: please own next touch within 1 business day."
        )
        slack_msg = ctx.slack.post_message(
            channel=channel,
            text=summary,
            thread_ts=thread_ts,
            idempotency_key=f"{wf}:slack:handoff",
        )

        return AgentResult(agent=self.name, status=AgentStatus.SUCCEEDED).succeed(
            {
                "hubspot_contact_id": contact["id"],
                "hubspot_deal_id": deal["id"],
                "slack_ts": slack_msg.get("ts"),
                "summary": summary,
            }
        )
