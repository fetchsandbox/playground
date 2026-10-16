"""Billing agent — Stripe customer + PaymentIntent for the quote amount."""

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

        intent = ctx.stripe.create_quote_payment_intent(
            customer_id=customer["id"],
            amount_cents=int(amount),
            currency=quote.get("currency", "usd"),
            description=f"Quote {quote.get('quote_id', wf)} — {req.sku} x{req.quantity}",
            receipt_email=req.customer_email,
            idempotency_key=f"{wf}:stripe:payment_intent",
            metadata={"workflow_id": wf, "sku": req.sku},
        )

        return AgentResult(agent=self.name, status=AgentStatus.SUCCEEDED).succeed(
            {
                "stripe_customer_id": customer["id"],
                "payment_intent_id": intent["id"],
                "invoice_id": intent["id"],  # alias for handoff copy
                "amount_due": intent.get("amount", amount),
                "currency": intent.get("currency", "usd"),
                "status": intent.get("status", "requires_payment_method"),
                "hosted_invoice_url": None,
                "replayed": bool(customer.get("_replayed") or intent.get("_replayed")),
            }
        )
