"""Billing agent — Stripe customer + draft invoice."""

from __future__ import annotations

from customer_ops.agents.base import SKU_PRICES_CENTS, AgentContext
from customer_ops.models import AgentName, AgentResult, AgentStatus


class BillingAgent:
    name = AgentName.BILLING

    def run(self, ctx: AgentContext) -> AgentResult:
        req = ctx.workflow.request
        wf = ctx.workflow.workflow_id
        customer = ctx.stripe.ensure_customer(
            email=req.customer_email,
            name=req.customer_name,
            idempotency_key=f"{wf}:stripe:customer",
        )

        quote = ctx.prior_output(AgentName.QUOTE)
        amount = quote.get("total_cents")
        if amount is None:
            amount = SKU_PRICES_CENTS.get(req.sku, 0) * max(1, req.quantity)

        invoice = ctx.stripe.create_quote_invoice(
            customer_id=customer["id"],
            amount_cents=int(amount),
            currency=quote.get("currency", "usd"),
            description=f"Quote {quote.get('quote_id', wf)} — {req.sku} x{req.quantity}",
            idempotency_key=f"{wf}:stripe:invoice",
        )

        return AgentResult(agent=self.name, status=AgentStatus.SUCCEEDED).succeed(
            {
                "stripe_customer_id": customer["id"],
                "invoice_id": invoice["id"],
                "amount_due": invoice.get("amount_due", amount),
                "currency": invoice.get("currency", "usd"),
                "status": invoice.get("status", "draft"),
                "hosted_invoice_url": invoice.get("hosted_invoice_url"),
                "replayed": bool(customer.get("_replayed") or invoice.get("_replayed")),
            }
        )
