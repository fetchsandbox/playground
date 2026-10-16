"""HubSpot CRM adapter (contacts + deals)."""

from __future__ import annotations

from typing import Any

import httpx

from customer_ops.integrations.base import IntegrationBus, env, use_mocks
from customer_ops.models import new_id


class HubSpotClient:
    def __init__(self, bus: IntegrationBus | None = None):
        self.bus = bus or IntegrationBus()
        self.token = env("HUBSPOT_ACCESS_TOKEN", "HUBSPOT_TOKEN")
        self.base = env("HUBSPOT_API_BASE", default="https://api.hubapi.com") or "https://api.hubapi.com"

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
            "firstname": first or None,
            "lastname": last or None,
            "company": company,
        }
        props = {k: v for k, v in props.items() if v}
        req = {"properties": props}
        if use_mocks() or not self.token:
            return self.bus.remember(
                service="hubspot",
                operation="contacts.upsert",
                request=req,
                response={"id": new_id("hs"), "properties": props},
                idempotency_key=idempotency_key,
            )
        with httpx.Client(timeout=20.0) as client:
            resp = client.post(
                f"{self.base}/crm/v3/objects/contacts/batch/upsert",
                json={
                    "inputs": [
                        {
                            "idProperty": "email",
                            "id": email,
                            "properties": props,
                        }
                    ]
                },
                headers={"Authorization": f"Bearer {self.token}"},
            )
            resp.raise_for_status()
            data = resp.json()
            result = (data.get("results") or [data])[0]
            return self.bus.remember(
                service="hubspot",
                operation="contacts.upsert",
                request=req,
                response=result,
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
        req = {
            "properties": {
                "dealname": dealname,
                "amount": str(amount),
                "dealstage": stage,
            },
            "associations": [{"to": {"id": contact_id}}],
        }
        if use_mocks() or not self.token:
            return self.bus.remember(
                service="hubspot",
                operation="deals.create",
                request=req,
                response={"id": new_id("deal"), "properties": req["properties"]},
                idempotency_key=idempotency_key,
            )
        with httpx.Client(timeout=20.0) as client:
            resp = client.post(
                f"{self.base}/crm/v3/objects/deals",
                json={
                    "properties": req["properties"],
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
                },
                headers={"Authorization": f"Bearer {self.token}"},
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
