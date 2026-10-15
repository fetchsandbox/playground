"""Pricing service.

Owns list prices and volume tiers. Exposed two ways:
  * `router` — mount it (or run it standalone) as the HTTP pricing service
  * `PricingClient` — what the orchestrator calls; talks HTTP when
    PRICING_SERVICE_URL is set, otherwise prices in-process.

Volume tiers are list pricing, not a negotiated discount, so they never go
through the discount approval policy.
"""

from decimal import ROUND_HALF_UP, Decimal

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .models import Product, QuoteLine, RequestedItem

CATALOG: dict[Product, dict] = {
    Product.STARTER: {"sku": "NW-STARTER-ANNUAL", "name": "Starter plan (per seat / year)", "unit_cents": 24_000, "per_seat": True},
    Product.PRO: {"sku": "NW-PRO-ANNUAL", "name": "Pro plan (per seat / year)", "unit_cents": 60_000, "per_seat": True},
    Product.ENTERPRISE: {"sku": "NW-ENT-ANNUAL", "name": "Enterprise plan (per seat / year)", "unit_cents": 120_000, "per_seat": True},
    Product.ONBOARDING: {"sku": "NW-ONBOARD", "name": "Guided onboarding (one-time)", "unit_cents": 250_000, "per_seat": False},
}

# (min seats, % off list) — highest matching tier wins
VOLUME_TIERS = [(200, Decimal("10")), (50, Decimal("5"))]


class PriceRequest(BaseModel):
    items: list[RequestedItem]
    currency: str = "USD"


class PriceResponse(BaseModel):
    currency: str
    lines: list[QuoteLine]
    subtotal_cents: int


def _round_cents(value: Decimal) -> int:
    return int(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def price_items(items: list[RequestedItem], currency: str = "USD") -> PriceResponse:
    if currency != "USD":
        raise ValueError(f"unsupported currency {currency}")
    if not items:
        raise ValueError("no items to price")
    lines: list[QuoteLine] = []
    for item in items:
        entry = CATALOG[item.product]
        unit = Decimal(entry["unit_cents"])
        note = None
        if entry["per_seat"]:
            for min_seats, pct in VOLUME_TIERS:
                if item.quantity >= min_seats:
                    unit = unit * (100 - pct) / 100
                    note = f"volume pricing: {pct}% off list for {min_seats}+ seats"
                    break
        unit_cents = _round_cents(unit)
        lines.append(
            QuoteLine(
                sku=entry["sku"],
                name=entry["name"],
                quantity=item.quantity,
                unit_price_cents=unit_cents,
                line_total_cents=unit_cents * item.quantity,
                note=note,
            )
        )
    return PriceResponse(currency=currency, lines=lines, subtotal_cents=sum(l.line_total_cents for l in lines))


def apply_discount(subtotal_cents: int, pct: Decimal) -> tuple[int, int]:
    """Return (discount_cents, total_cents)."""
    discount = _round_cents(Decimal(subtotal_cents) * pct / 100)
    return discount, subtotal_cents - discount


router = APIRouter(prefix="/pricing", tags=["pricing"])


@router.post("/quote", response_model=PriceResponse)
def quote_endpoint(body: PriceRequest) -> PriceResponse:
    try:
        return price_items(body.items, body.currency)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


class PricingClient:
    def __init__(self, base_url: str = "", http: httpx.Client | None = None):
        self.base_url = base_url.rstrip("/")
        self._http = http

    def price(self, items: list[RequestedItem]) -> PriceResponse:
        if not self.base_url:
            return price_items(items)
        http = self._http or httpx.Client(timeout=10.0)
        r = http.post(
            f"{self.base_url}/pricing/quote",
            json=PriceRequest(items=items).model_dump(mode="json"),
        )
        r.raise_for_status()
        return PriceResponse.model_validate(r.json())
