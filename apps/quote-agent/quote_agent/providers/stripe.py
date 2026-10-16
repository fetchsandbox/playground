"""Stripe client for the billing agent: customers and one-off invoices.

Every create sends an Idempotency-Key, but the billing agent never relies on
that alone: it looks the customer and the run's invoice up before creating
them, so a repeated step finds what the first attempt made.

Requests are form-encoded, as the Stripe API expects (`metadata[key]=value`).
"""

import time
from typing import Any

import httpx


class StripeError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def _form(data: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in data.items():
        if value is None:
            continue
        if isinstance(value, dict):
            for k, v in value.items():
                out[f"{key}[{k}]"] = str(v)
        elif isinstance(value, bool):
            out[key] = "true" if value else "false"
        else:
            out[key] = str(value)
    return out


class StripeClient:
    def __init__(self, base_url: str, secret_key: str, http: httpx.Client | None = None):
        self._http = http or httpx.Client(timeout=20.0)
        self.base_url = base_url.rstrip("/")
        self.headers = {"Authorization": f"Bearer {secret_key}"}

    def _request(self, method: str, path: str, *, data: dict | None = None, params: dict | None = None,
                 idempotency_key: str | None = None) -> dict[str, Any]:
        headers = dict(self.headers)
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        for attempt in range(3):
            r = self._http.request(method, f"{self.base_url}{path}", headers=headers,
                                   data=_form(data) if data is not None else None, params=params)
            if r.status_code != 429 or attempt == 2:
                break
            time.sleep(min(float(r.headers.get("Retry-After", "1")), 10.0))
        if r.status_code >= 300:
            raise StripeError(f"{method} {path}: HTTP {r.status_code} {r.text[:300]}", r.status_code)
        return r.json() if r.content else {}

    # --- customers ----------------------------------------------------------

    def find_customer(self, email: str) -> dict[str, Any] | None:
        found = self._request("GET", "/v1/customers", params={"email": email, "limit": 10}).get("data") or []
        matches = [c for c in found if (c.get("email") or "").lower() == email.lower()]
        return matches[0] if matches else None

    def create_customer(self, *, email: str, name: str | None, metadata: dict[str, str],
                        idempotency_key: str) -> dict[str, Any]:
        return self._request("POST", "/v1/customers", data={"email": email, "name": name, "metadata": metadata},
                             idempotency_key=idempotency_key)

    # --- invoices -----------------------------------------------------------

    def list_invoices(self, customer_id: str) -> list[dict[str, Any]]:
        return self._request("GET", "/v1/invoices", params={"customer": customer_id, "limit": 100}).get("data") or []

    def get_invoice(self, invoice_id: str) -> dict[str, Any]:
        return self._request("GET", f"/v1/invoices/{invoice_id}")

    def create_invoice(self, *, customer_id: str, metadata: dict[str, str], days_until_due: int,
                       idempotency_key: str) -> dict[str, Any]:
        # auto_advance=false: Stripe must not finalize or email the invoice on its own.
        # The messaging agent tells the customer, once, after the invoice is verified.
        return self._request("POST", "/v1/invoices", data={
            "customer": customer_id, "collection_method": "send_invoice", "days_until_due": days_until_due,
            "auto_advance": False, "pending_invoice_items_behavior": "exclude", "metadata": metadata,
        }, idempotency_key=idempotency_key)

    def add_invoice_item(self, *, customer_id: str, invoice_id: str, amount_cents: int, currency: str,
                         description: str, idempotency_key: str) -> dict[str, Any]:
        return self._request("POST", "/v1/invoiceitems", data={
            "customer": customer_id, "invoice": invoice_id, "amount": amount_cents,
            "currency": currency.lower(), "description": description,
        }, idempotency_key=idempotency_key)

    def finalize_invoice(self, invoice_id: str, *, idempotency_key: str) -> dict[str, Any]:
        # No options: auto_advance=false was set when the invoice was created.
        return self._request("POST", f"/v1/invoices/{invoice_id}/finalize", idempotency_key=idempotency_key)
