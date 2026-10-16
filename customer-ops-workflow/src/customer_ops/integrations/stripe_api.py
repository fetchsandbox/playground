"""Stripe billing adapter — Customer + PaymentIntent (twin-compatible REST)."""

from __future__ import annotations

from typing import Any

import httpx

from customer_ops.integrations.base import (
    IntegrationBus,
    env,
    flow_headers,
    join_base,
    use_mocks,
)
from customer_ops.models import new_id


class StripeClient:
    def __init__(self, bus: IntegrationBus | None = None):
        self.bus = bus or IntegrationBus()
        self.api_key = env("STRIPE_API_KEY", "STRIPE_SECRET_KEY")
        self.base = (
            env("STRIPE_API_BASE", "STRIPE_BASE_URL", default="https://api.stripe.com")
            or "https://api.stripe.com"
        )

    def _headers(self, idempotency_key: str | None = None) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            **flow_headers(),
        }
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return headers

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
                join_base(self.base, "/v1/customers"),
                data={"email": email, **({"name": name} if name else {})},
                headers=self._headers(idempotency_key),
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

    def create_quote_payment_intent(
        self,
        *,
        customer_id: str,
        amount_cents: int,
        currency: str,
        description: str,
        receipt_email: str,
        idempotency_key: str,
        metadata: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """POST /v1/payment_intents — primary twin-verified billing effect."""
        meta = metadata or {}
        req = {
            "customer": customer_id,
            "amount": amount_cents,
            "currency": currency,
            "description": description,
            "receipt_email": receipt_email,
            "metadata": meta,
        }
        if use_mocks() or not self.api_key:
            return self.bus.remember(
                service="stripe",
                operation="payment_intents.create",
                request=req,
                response={
                    "id": new_id("pi"),
                    "object": "payment_intent",
                    "customer": customer_id,
                    "amount": amount_cents,
                    "currency": currency,
                    "status": "requires_payment_method",
                    "description": description,
                    "receipt_email": receipt_email,
                    "metadata": meta,
                },
                idempotency_key=idempotency_key,
            )
        form: dict[str, Any] = {
            "customer": customer_id,
            "amount": amount_cents,
            "currency": currency,
            "description": description,
            "receipt_email": receipt_email,
            "confirm": "false",
        }
        for k, v in meta.items():
            form[f"metadata[{k}]"] = v
        with httpx.Client(timeout=20.0) as client:
            resp = client.post(
                join_base(self.base, "/v1/payment_intents"),
                data=form,
                headers=self._headers(idempotency_key),
            )
            resp.raise_for_status()
            data = resp.json()
            return self.bus.remember(
                service="stripe",
                operation="payment_intents.create",
                request=req,
                response=data,
                idempotency_key=idempotency_key,
            )

    # Back-compat alias used by older callers / docs
    def create_quote_invoice(self, **kwargs: Any) -> dict[str, Any]:
        receipt_email = kwargs.pop("receipt_email", None) or kwargs.pop("email", "ops@example.test")
        return self.create_quote_payment_intent(receipt_email=receipt_email, **kwargs)
