"""HubSpot CRM adapter — contacts + deals (twin-compatible REST)."""

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


class HubSpotClient:
    def __init__(self, bus: IntegrationBus | None = None):
        self.bus = bus or IntegrationBus()
        self.token = env("HUBSPOT_ACCESS_TOKEN", "HUBSPOT_TOKEN", "HUBSPOT_API_KEY")
        self.base = (
            env("HUBSPOT_API_BASE", "HUBSPOT_BASE_URL", default="https://api.hubapi.com")
            or "https://api.hubapi.com"
        )

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            **flow_headers(),
        }

    def upsert_contact(
        self,
        *,
        email: str,
        name: str | None,
        company: str | None,
        idempotency_key: str,
    ) -> dict[str, Any]:
        first, _, last = (name or "").partition(" ")
        props = {
            "email": email,
            "firstname": first or "Customer",
            "lastname": last or "Ops",
            "company": company or "",
        }
        req = {"properties": props}
        if use_mocks() or not self.token:
            return self.bus.remember(
                service="hubspot",
                operation="contacts.create",
                request=req,
                response={"id": new_id("hs"), "properties": props},
                idempotency_key=idempotency_key,
            )
        # Twin-compatible: POST /crm/v3/objects/contacts (not batch upsert).
        with httpx.Client(timeout=20.0) as client:
            resp = client.post(
                join_base(self.base, "/crm/v3/objects/contacts"),
                json=req,
                headers=self._headers(),
            )
            # 409 / conflict → treat as success-shaped for handoff continuity
            if resp.status_code >= 400:
                # Retry as search-by-email is twin-optional; surface error to scope.
                resp.raise_for_status()
            data = resp.json()
            return self.bus.remember(
                service="hubspot",
                operation="contacts.create",
                request=req,
                response=data,
                idempotency_key=idempotency_key,
            )

    def create_deal(
        self,
        *,
        dealname: str,
        amount: float,
        contact_id: str,
        stage: str = "appointmentscheduled",
        idempotency_key: str,
    ) -> dict[str, Any]:
        props = {
            "dealname": dealname,
            "amount": str(amount),
            "dealstage": stage,
        }
        req = {"properties": props, "associations": [{"to": {"id": contact_id}}]}
        if use_mocks() or not self.token:
            return self.bus.remember(
                service="hubspot",
                operation="deals.create",
                request=req,
                response={"id": new_id("deal"), "properties": props},
                idempotency_key=idempotency_key,
            )
        body: dict[str, Any] = {
            "properties": props,
            "associations": [
                {
                    "to": {"id": contact_id},
                    "types": [
                        {
                            "associationCategory": "HUBSPOT_DEFINED",
                            "associationTypeId": 3,
                        }
                    ],
                }
            ],
        }
        with httpx.Client(timeout=20.0) as client:
            resp = client.post(
                join_base(self.base, "/crm/v3/objects/deals"),
                json=body,
                headers=self._headers(),
            )
            resp.raise_for_status()
            data = resp.json()
            return self.bus.remember(
                service="hubspot",
                operation="deals.create",
                request=req,
                response=data,
                idempotency_key=idempotency_key,
            )
