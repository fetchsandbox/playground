"""The three agents of the customer handoff.

Each agent holds only its own provider client and does one thing:

    CrmAgent        HubSpot: contact lifecycle stage -> customer
    BillingAgent    Stripe:  one invoice for the accepted quote, finalized
    MessagingAgent  Resend:  one welcome email with the invoice

Every `act` is safe to run again for the same run. That is what lets the
workflow resolve an uncertain step (request sent, response lost) by acting
again instead of guessing:
  * CRM reads the stage first and writes only if it is not already customer.
  * Billing looks up the customer and this run's invoice before creating them.
  * Messaging repeats the send with the same Idempotency-Key and body, which
    Resend answers with the original email instead of sending a second one.

`verify` reads the provider back; a step only counts once that read agrees.
"""

from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from ..models import Quote
from ..providers.hubspot import HubSpotClient
from ..providers.resend import ResendClient
from ..providers.stripe import StripeClient


def money(cents: int) -> str:
    return f"${Decimal(cents) / 100:,.2f}"


@dataclass
class StepContext:
    run_id: str
    quote: Quote
    effects: dict[str, dict[str, Any]]  # verified effects of earlier steps, by step name


class HandoffAgent:
    name: str
    action: str

    def payload(self, ctx: StepContext) -> dict[str, Any]:
        raise NotImplementedError

    def act(self, ctx: StepContext) -> dict[str, Any]:
        raise NotImplementedError

    def verify(self, ctx: StepContext, effect: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
        raise NotImplementedError


class CrmAgent(HandoffAgent):
    name = "crm"
    action = "crm.set_lifecycle_stage"
    WON = {"customer", "evangelist"}  # HubSpot stages at or past customer

    def __init__(self, hubspot: HubSpotClient):
        self.hubspot = hubspot

    def payload(self, ctx: StepContext) -> dict[str, Any]:
        return {"email": ctx.quote.customer_email.lower(), "contact_id": ctx.quote.hubspot_contact_id,
                "lifecyclestage": "customer"}

    def _contact_id(self, ctx: StepContext) -> str:
        if ctx.quote.hubspot_contact_id:
            return ctx.quote.hubspot_contact_id
        return self.hubspot.ensure_contact(ctx.quote.customer_email)["id"]

    def act(self, ctx: StepContext) -> dict[str, Any]:
        contact_id = self._contact_id(ctx)
        before = (self.hubspot.read_contact(contact_id, ["email", "lifecyclestage"]).get("properties") or {})
        stage = before.get("lifecyclestage")
        if stage not in self.WON:
            self.hubspot.update_contact(contact_id, {"lifecyclestage": "customer"})
        return {"contact_id": contact_id, "stage_before": stage, "wrote": stage not in self.WON}

    def verify(self, ctx: StepContext, effect: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
        props = self.hubspot.read_contact(effect["contact_id"], ["email", "lifecyclestage"]).get("properties") or {}
        stage = props.get("lifecyclestage")
        email_ok = (props.get("email") or "").lower() == ctx.quote.customer_email.lower()
        return stage in self.WON and email_ok, {"lifecyclestage": stage, "email_matches": email_ok}


class BillingMismatch(RuntimeError):
    """An invoice for this run exists but does not match the quote; a human must look."""


class BillingAgent(HandoffAgent):
    name = "billing"
    action = "billing.issue_invoice"

    def __init__(self, stripe: StripeClient, days_until_due: int = 30):
        self.stripe = stripe
        self.days_until_due = days_until_due

    def payload(self, ctx: StepContext) -> dict[str, Any]:
        q = ctx.quote
        return {"quote_id": q.id, "customer_email": q.customer_email.lower(), "amount_cents": q.total_cents,
                "currency": q.currency.lower()}

    def _description(self, q: Quote) -> str:
        lines = "; ".join(f"{l.quantity} x {l.name}" for l in q.lines)
        discount = f", {q.discount_pct:g}% discount applied" if q.discount_cents else ""
        return f"Quote {q.id}: {lines}{discount}"

    def _find_invoice(self, customer_id: str, run_id: str) -> dict[str, Any] | None:
        for inv in self.stripe.list_invoices(customer_id):
            if (inv.get("metadata") or {}).get("handoff_run") == run_id and inv.get("status") != "void":
                return self.stripe.get_invoice(inv["id"])
        return None

    def act(self, ctx: StepContext) -> dict[str, Any]:
        q, run = ctx.quote, ctx.run_id
        created = {"customer_created": False, "invoice_created": False, "item_added": False}
        customer = self.stripe.find_customer(q.customer_email)
        if customer is None:
            customer = self.stripe.create_customer(email=q.customer_email, name=q.company or q.customer_name,
                                                   metadata={"quote_id": q.id}, idempotency_key=f"{run}:customer")
            created["customer_created"] = True
        invoice = self._find_invoice(customer["id"], run)
        if invoice is None:
            invoice = self.stripe.create_invoice(customer_id=customer["id"], metadata={"handoff_run": run, "quote_id": q.id},
                                                 days_until_due=self.days_until_due, idempotency_key=f"{run}:invoice")
            created["invoice_created"] = True
        if invoice.get("status") == "draft":
            lines = (invoice.get("lines") or {}).get("data") or []
            if not lines:
                self.stripe.add_invoice_item(customer_id=customer["id"], invoice_id=invoice["id"],
                                             amount_cents=q.total_cents, currency=q.currency,
                                             description=self._description(q), idempotency_key=f"{run}:item")
                created["item_added"] = True
            elif sum(int(l.get("amount", 0)) for l in lines) != q.total_cents:
                raise BillingMismatch(f"draft invoice {invoice['id']} lines do not add up to {q.total_cents}")
            invoice = self.stripe.finalize_invoice(invoice["id"], idempotency_key=f"{run}:finalize")
        return {"customer_id": customer["id"], "invoice_id": invoice["id"], **created}

    def verify(self, ctx: StepContext, effect: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
        inv = self.stripe.get_invoice(effect["invoice_id"])
        q = ctx.quote
        checks = {
            "status_open": inv.get("status") == "open",
            "total_matches_quote": int(inv.get("total") or 0) == q.total_cents,
            "currency_matches": (inv.get("currency") or "").lower() == q.currency.lower(),
            "quote_id_matches": (inv.get("metadata") or {}).get("quote_id") == q.id,
            "customer_matches": inv.get("customer") == effect["customer_id"],
        }
        detail = {**checks, "invoice_id": inv.get("id"), "number": inv.get("number"), "total": inv.get("total"),
                  "hosted_invoice_url": inv.get("hosted_invoice_url"), "due_date": inv.get("due_date")}
        return all(checks.values()), detail


class MessagingAgent(HandoffAgent):
    name = "messaging"
    action = "email.send_welcome"

    def __init__(self, resend: ResendClient, sender: str, company_name: str, account_team: str):
        self.resend = resend
        self.sender = sender
        self.company_name = company_name
        self.account_team = account_team

    def _message(self, ctx: StepContext) -> dict[str, Any]:
        # Deterministic: a repeated send must carry the identical body for its Idempotency-Key.
        q = ctx.quote
        inv = ctx.effects["billing_invoice"]
        name = (q.customer_name or "there").split()[0]
        link = f"\nView and pay it here: {inv['hosted_invoice_url']}\n" if inv.get("hosted_invoice_url") else ""
        text = "\n".join([
            f"Hi {name},", "",
            f"Welcome to {self.company_name}! Your order from quote {q.id} is confirmed.", "",
            f"Invoice {inv.get('number') or inv['invoice_id']} for {money(q.total_cents)} ({q.currency}) "
            f"is due within the terms on the invoice.{link}",
            f"Your account team: {self.account_team}. Reply to this email with any questions.", "",
            f"— {self.company_name}",
        ])
        return {"to": [q.customer_email], "subject": f"Welcome to {self.company_name} — invoice for quote {q.id}",
                "text": text}

    def payload(self, ctx: StepContext) -> dict[str, Any]:
        return {**self._message(ctx), "idempotency_key": self._key(ctx)}

    @staticmethod
    def _key(ctx: StepContext) -> str:
        return f"handoff-{ctx.run_id}-welcome"

    def act(self, ctx: StepContext) -> dict[str, Any]:
        m = self._message(ctx)
        sent = self.resend.send_email(sender=self.sender, to=m["to"], subject=m["subject"], text=m["text"],
                                      idempotency_key=self._key(ctx))
        return {"email_id": sent["id"]}

    def verify(self, ctx: StepContext, effect: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
        email = self.resend.get_email(effect["email_id"])
        m = self._message(ctx)
        to = [t.lower() for t in (email.get("to") or [])] if isinstance(email.get("to"), list) else [str(email.get("to")).lower()]
        last_event = email.get("last_event")
        checks = {
            "recipient_matches": ctx.quote.customer_email.lower() in to,
            "subject_matches": email.get("subject") == m["subject"],
            "not_bounced": last_event not in {"bounced", "complained"},
        }
        return all(checks.values()), {**checks, "email_id": email.get("id"), "last_event": last_event}
