"""Shared data shapes for the quote workflow."""

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


class Intent(str, Enum):
    QUOTE_REQUEST = "quote_request"
    DISCOUNT_REQUEST = "discount_request"
    OTHER = "other"


class Product(str, Enum):
    STARTER = "starter"
    PRO = "pro"
    ENTERPRISE = "enterprise"
    ONBOARDING = "onboarding"


class RequestedItem(BaseModel):
    product: Product
    quantity: int = Field(ge=1)


class Classification(BaseModel):
    intent: Intent
    confidence: float = Field(ge=0, le=1)
    items: list[RequestedItem] = []
    requested_discount_percent: float | None = None
    referenced_quote_id: str | None = None
    customer_name: str | None = None
    summary: str = ""
    classifier: str = "unknown"


class InboundMessage(BaseModel):
    """A customer message, normalised from whichever channel it came in on."""

    channel: Literal["email", "slack"]
    external_id: str  # Gmail message id / Slack event id — the dedupe key
    sender_email: str | None
    sender_name: str | None = None
    subject: str | None = None
    text: str
    # Everything needed to reply in the same conversation:
    #   email: {"thread_id", "message_id_header", "subject"}
    #   slack: {"channel", "thread_ts", "user"}
    reply_ref: dict[str, Any] = {}


class QuoteLine(BaseModel):
    sku: str
    name: str
    quantity: int
    unit_price_cents: int
    line_total_cents: int
    note: str | None = None


class Quote(BaseModel):
    id: str
    version: int = 1
    parent_quote_id: str | None = None
    customer_email: str
    customer_name: str | None = None
    company: str | None = None
    hubspot_contact_id: str | None = None
    hubspot_deal_id: str | None = None
    currency: str = "USD"
    lines: list[QuoteLine]
    subtotal_cents: int
    discount_pct: float = 0
    discount_cents: int = 0
    total_cents: int
    status: Literal["draft", "sent", "superseded", "pending_approval"] = "draft"
    created_at: str
    valid_until: str
