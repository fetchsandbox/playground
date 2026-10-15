"""Discount authorization policy.

This is the only place that decides what the agent may do with a discount
request. It is plain code on purpose: the LLM extracts the percentage the
customer asked for, but it never decides whether that percentage is allowed,
so nothing in a customer's message can talk the agent into a bigger discount.

    requested <  20%          -> AUTO_APPROVE    apply it and send the quote
    20% <= requested <= 70%   -> NEEDS_APPROVAL  ask a manager in Slack
    requested >  70%          -> DECLINE         stop, tell the manager
"""

from dataclasses import dataclass
from decimal import Decimal
from enum import Enum


class DiscountDecision(str, Enum):
    AUTO_APPROVE = "auto_approve"
    NEEDS_APPROVAL = "needs_approval"
    DECLINE = "decline"
    INVALID = "invalid"


@dataclass(frozen=True)
class DiscountPolicy:
    approval_threshold_pct: Decimal = Decimal("20")
    decline_above_pct: Decimal = Decimal("70")

    def __post_init__(self):
        if not (0 < self.approval_threshold_pct <= self.decline_above_pct <= 100):
            raise ValueError("need 0 < approval_threshold <= decline_above <= 100")

    def decide(self, requested_pct: Decimal | float | int | str | None) -> DiscountDecision:
        if requested_pct is None:
            return DiscountDecision.INVALID
        pct = Decimal(str(requested_pct))
        if pct <= 0 or pct > 100:
            return DiscountDecision.INVALID
        if pct > self.decline_above_pct:
            return DiscountDecision.DECLINE
        if pct >= self.approval_threshold_pct:
            return DiscountDecision.NEEDS_APPROVAL
        return DiscountDecision.AUTO_APPROVE
