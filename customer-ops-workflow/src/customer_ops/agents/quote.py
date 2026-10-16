"""Quote request agent — pricing package from research + SKU."""

from __future__ import annotations

from customer_ops.agents.base import SKU_PRICES_CENTS, AgentContext
from customer_ops.models import AgentError, AgentName, AgentResult, AgentStatus


class QuoteAgent:
    name = AgentName.QUOTE

    def run(self, ctx: AgentContext) -> AgentResult:
        req = ctx.workflow.request
        research = ctx.prior_output(AgentName.RESEARCH)
        sku = research.get("recommended_sku") or req.sku
        unit = SKU_PRICES_CENTS.get(sku)
        if unit is None:
            return AgentResult(agent=self.name, status=AgentStatus.FAILED).fail(
                AgentError(code="unknown_sku", message=f"No price for sku={sku}", retryable=False)
            )

        qty = max(1, req.quantity)
        # Mid-market research signal → 10% volume discount on qty>=3
        discount_pct = 10 if qty >= 3 and research.get("segment") == "mid-market" else 0
        subtotal = unit * qty
        discount = int(subtotal * discount_pct / 100)
        total = subtotal - discount

        quote = {
            "quote_id": f"q_{ctx.workflow.workflow_id}",
            "sku": sku,
            "quantity": qty,
            "unit_cents": unit,
            "discount_pct": discount_pct,
            "subtotal_cents": subtotal,
            "total_cents": total,
            "currency": "usd",
            "company": research.get("company") or req.company,
            "valid_days": 14,
            "line_items": [
                {
                    "sku": sku,
                    "quantity": qty,
                    "unit_cents": unit,
                    "total_cents": total,
                }
            ],
        }
        return AgentResult(agent=self.name, status=AgentStatus.SUCCEEDED).succeed(quote)
