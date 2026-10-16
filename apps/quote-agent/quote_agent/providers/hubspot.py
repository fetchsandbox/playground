"""HubSpot CRM v3 client: contacts and deals.

Every write is read back before it is trusted — a 2xx from the create call is
not proof the record holds what we sent.
"""

import re
import time
from decimal import Decimal
from typing import Any

import httpx


class HubSpotError(RuntimeError):
    pass


_EXISTING_ID = re.compile(r"Existing ID:\s*(\d+)")
DEAL_TO_CONTACT = 3  # HUBSPOT_DEFINED association type id


class HubSpotClient:
    def __init__(self, base_url: str, token: str, http: httpx.Client | None = None):
        self._http = http or httpx.Client(timeout=20.0)
        self.base_url = base_url.rstrip("/")
        self.headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    def _request(self, method: str, path: str, **kw) -> httpx.Response:
        for attempt in range(3):
            r = self._http.request(method, f"{self.base_url}{path}", headers=self.headers, **kw)
            if r.status_code != 429 or attempt == 2:
                return r
            time.sleep(min(float(r.headers.get("Retry-After", "1")), 10.0))
        return r

    def _ok(self, r: httpx.Response, what: str) -> dict[str, Any]:
        if r.status_code >= 300:
            raise HubSpotError(f"{what} failed: HTTP {r.status_code} {r.text[:300]}")
        return r.json() if r.content else {}

    # --- contacts -----------------------------------------------------------

    def find_contact_by_email(self, email: str) -> dict[str, Any] | None:
        r = self._request("POST", "/crm/v3/objects/contacts/search", json={
            "filterGroups": [{"filters": [{"propertyName": "email", "operator": "EQ", "value": email}]}],
            "properties": ["email", "firstname", "lastname", "company"],
            "limit": 1,
        })
        results = self._ok(r, "contact search").get("results") or []
        return results[0] if results else None

    def get_contact(self, contact_id: str) -> dict[str, Any]:
        r = self._request("GET", f"/crm/v3/objects/contacts/{contact_id}",
                          params={"properties": "email,firstname,lastname,company"})
        return self._ok(r, "contact read")

    def ensure_contact(self, email: str, firstname: str | None = None, lastname: str | None = None) -> dict[str, Any]:
        """Find the contact, creating it if it doesn't exist yet."""
        found = self.find_contact_by_email(email)
        if found:
            return found
        props = {"email": email}
        if firstname:
            props["firstname"] = firstname
        if lastname:
            props["lastname"] = lastname
        r = self._request("POST", "/crm/v3/objects/contacts", json={"properties": props})
        if r.status_code == 409:
            # Search index lags writes; the 409 names the record that already exists.
            m = _EXISTING_ID.search(r.text)
            if not m:
                raise HubSpotError(f"contact create conflict without an id: {r.text[:300]}")
            return self.get_contact(m.group(1))
        created = self._ok(r, "contact create")
        stored = self.get_contact(created["id"])
        if (stored.get("properties") or {}).get("email", "").lower() != email.lower():
            raise HubSpotError(f"contact {created['id']} read back with a different email")
        return stored

    def read_contact(self, contact_id: str, properties: list[str]) -> dict[str, Any]:
        r = self._request("GET", f"/crm/v3/objects/contacts/{contact_id}", params={"properties": ",".join(properties)})
        return self._ok(r, "contact read")

    def update_contact(self, contact_id: str, properties: dict[str, str]) -> dict[str, Any]:
        r = self._request("PATCH", f"/crm/v3/objects/contacts/{contact_id}", json={"properties": properties})
        return self._ok(r, "contact update")

    # --- deals (one deal per quote; revisions update its amount) ------------

    def get_deal(self, deal_id: str) -> dict[str, Any]:
        r = self._request("GET", f"/crm/v3/objects/deals/{deal_id}",
                          params={"properties": "dealname,amount,dealstage,pipeline,quote_id"})
        return self._ok(r, "deal read")

    def create_deal(self, *, name: str, amount_cents: int, contact_id: str, pipeline: str, stage: str) -> dict[str, Any]:
        amount = _dollars(amount_cents)
        r = self._request("POST", "/crm/v3/objects/deals", json={
            "properties": {"dealname": name, "amount": amount, "pipeline": pipeline, "dealstage": stage},
            "associations": [{
                "to": {"id": contact_id},
                "types": [{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": DEAL_TO_CONTACT}],
            }],
        })
        created = self._ok(r, "deal create")
        return self._verify_amount(created["id"], amount)

    def update_deal_amount(self, deal_id: str, *, amount_cents: int, name: str | None = None) -> dict[str, Any]:
        amount = _dollars(amount_cents)
        props = {"amount": amount}
        if name:
            props["dealname"] = name
        r = self._request("PATCH", f"/crm/v3/objects/deals/{deal_id}", json={"properties": props})
        self._ok(r, "deal update")
        return self._verify_amount(deal_id, amount)

    def _verify_amount(self, deal_id: str, amount: str) -> dict[str, Any]:
        stored = self.get_deal(deal_id)
        got = (stored.get("properties") or {}).get("amount")
        if got is None or Decimal(str(got)) != Decimal(amount):
            raise HubSpotError(f"deal {deal_id} read back amount {got!r}, expected {amount}")
        return stored


def _dollars(cents: int) -> str:
    return str((Decimal(cents) / 100).quantize(Decimal("0.01")))
