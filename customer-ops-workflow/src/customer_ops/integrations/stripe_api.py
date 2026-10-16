"""Stripe billing adapter (PaymentIntent / Customer)."""

from __future__ import annotations

from typing import Any

import httpx

from customer_ops.integrations.base import IntegrationBus, env, use_mocks
from customer_ops.models import new_id


class StripeClient:
    def __init__(self, bus: IntegrationBus | None = None):
        self.bus = bus or IntegrationBus()
        self.api_key = env("STRIPE_API_KEY", "STRIPE_SECRET_KEY")
        self.base = env("STRIPE_API_BASE", default="https://api.stripe.com") or "https://api.stripe.com"

    def ensure_customer(self, *, email: str, name: str | None, idempotency_key: str) -> dict[str, Any]:
        req = {"email": email, "name": name}
        if use_mocks() or not self.api_key:
            return self.bus.remember(
                service="stripe",
                operation="customers.create",
                request=req,
                response={"id": new_id("cus"), "email": email, "name": name, "object": "customer"},
                idempotency_key=idempotency_key,
            )
        with httpx.Client(timeout=20.0) as client:
            resp = client.post(
                f"{self.base}/v1/customers",
                data={"email": email, **({"name": name} if name else {})},
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Idempotency-Key": idempotency_key,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            return self.bus.remember(
                service="stripe",
                operation="customers.create",
                request=req,
                response=data,
                idempotency_key=idempotency_key,
            )

    def create_quote_invoice(
        self,
        *,
        customer_id: str,
        amount_cents: int,
        currency: str,
        description: str,
        idempotency_key: str,
    ) -> dict[str, Any]:
        req = {
            "customer": customer_id,
            "amount": amount_cents,
            "currency": currency,
            "description": description,
        }
        if use_mocks() or not self.api_key:
            return self.bus.remember(
                service="stripe",
                operation="invoices.create",
                request=req,
                response={
                    "id": new_id("in"),
                    "customer": customer_id,
                    "amount_due": amount_cents,
                    "currency": currency,
                    "status": "draft",
                    "description": description,
                    "hosted_invoice_url": f"https://invoice.stripe.com/i/{new_id('url')}",
                },
                idempotency_key=idempotency_key,
            )
        with httpx.Client(timeout=20.0) as client:
            resp = client.post(
                f"{self.base}/v1/invoices",
                data={
                    "customer": customer_id,
                    "collection_method": "send_invoice",
                    "days_until_due": 14,
                    "description": description,
                    "auto_advance": "false",
                },
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Idempotency-Key": idempotency_key,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            return self.bus.remember(
                service="stripe",
                operation="invoices.create",
                request=req,
                response=data,
                idempotency_key=idempotency_key,
            )
