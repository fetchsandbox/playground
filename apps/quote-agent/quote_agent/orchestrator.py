"""The quote workflow.

Each inbound message becomes a persisted *run*. A run moves through named
steps, and every step is recorded (status, detail, timestamps) so a run can
be inspected at GET /runs/{id} and resumed after a manager decides.

    inbound ─► classify ─┬─ quote_request ──► resolve_customer ─► price ─► record_crm ─► send_quote
                         │
                         ├─ discount_request ─► resolve_customer ─► load_base_quote ─► policy
                         │        policy: < 20%      ─► apply_discount ─► record_crm ─► send_quote
                         │                20% – 70%  ─► request_approval (Slack) ══ pause ══╗
                         │                > 70%      ─► notify_manager_declined            ║
                         │                                                                 ║
                         │    manager clicks Approve ─► record_crm ─► send_quote  ◄════════╣
                         │    manager clicks Reject  ─► notify_customer_rejected ◄═════════╝
                         │
                         └─ other / low confidence ─► triage (Slack)

Run statuses: running, awaiting_approval, completed, declined, rejected,
needs_info, triaged, failed.
"""

import logging
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Callable

from .classifier import IntentClassifier
from .config import Settings
from .models import Classification, InboundMessage, Intent, Quote
from .policy import DiscountDecision, DiscountPolicy
from .pricing import PricingClient, apply_discount
from .providers.gmail import GmailClient
from .providers.hubspot import HubSpotClient
from .providers.slack import SlackClient
from .store import Store, now_iso

log = logging.getLogger(__name__)


def _money(cents: int) -> str:
    return f"${Decimal(cents) / 100:,.2f}"


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8].upper()}"


def _pct(value: float | Decimal) -> str:
    return f"{Decimal(str(value)).normalize():f}%"


class Orchestrator:
    def __init__(self, *, settings: Settings, store: Store, classifier: IntentClassifier,
                 pricing: PricingClient, hubspot: HubSpotClient | None,
                 slack: SlackClient | None, gmail: GmailClient | None):
        self.s = settings
        self.store = store
        self.classifier = classifier
        self.pricing = pricing
        self.hubspot = hubspot
        self.slack = slack
        self.gmail = gmail
        self.policy = DiscountPolicy(settings.approval_threshold_pct, settings.decline_above_pct)

    # ======================================================================
    # Entry points
    # ======================================================================

    def handle_inbound(self, msg: InboundMessage) -> dict[str, Any] | None:
        """Run the workflow for one customer message. None if it was a duplicate delivery."""
        if not self.store.claim_event(f"{msg.channel}:{msg.external_id}"):
            log.info("duplicate %s message %s ignored", msg.channel, msg.external_id)
            return None
        run = {
            "id": _new_id("RUN"),
            "status": "running",
            "inbound": msg.model_dump(),
            "steps": [],
            "created_at": now_iso(),
        }
        self.store.save_run(run)
        return self._guard(run, lambda: self._route(run, msg))

    def resume_approval(self, approval_id: str, decision: str, decided_by: str) -> dict[str, Any] | None:
        """Continue a run paused on manager approval. decision: 'approved' | 'rejected'."""
        if decision not in {"approved", "rejected"}:
            raise ValueError(decision)
        approval = self.store.get_approval(approval_id)
        if approval is None:
            raise KeyError(approval_id)
        if not self.store.decide_approval(approval_id, decision):
            log.info("approval %s already decided (%s)", approval_id, approval["status"])
            return None
        run = self.store.get_run(approval["run_id"])
        msg = InboundMessage.model_validate(run["inbound"])
        run["status"] = "running"
        run["approval_decision"] = {"decision": decision, "by": decided_by, "at": now_iso()}
        return self._guard(run, lambda: self._finish_approval(run, msg, approval, decision, decided_by))

    # ======================================================================
    # Routing
    # ======================================================================

    def _route(self, run: dict, msg: InboundMessage) -> None:
        c: Classification = self._step(run, "classify", lambda: self.classifier.classify(msg.text, msg.subject),
                                       detail=lambda c: c.model_dump(mode="json"))
        run["classification"] = c.model_dump(mode="json")

        if c.intent == Intent.OTHER or c.confidence < self.s.min_confidence:
            return self._triage(run, msg, f"intent={c.intent.value} confidence={c.confidence:.2f}")
        if not msg.sender_email:
            return self._triage(run, msg, "could not determine the customer's email address")

        if c.intent == Intent.QUOTE_REQUEST:
            return self._quote_flow(run, msg, c)
        return self._discount_flow(run, msg, c)

    # --- plain quote -------------------------------------------------------

    def _quote_flow(self, run: dict, msg: InboundMessage, c: Classification) -> None:
        if not c.items:
            return self._ask_for_details(run, msg, "Which plan and how many seats would you like quoted?")
        contact = self._resolve_customer(run, msg, c)
        quote = self._price_new_quote(run, msg, c, contact)
        self._record_and_send(run, msg, quote)
        run["status"] = "completed"

    # --- discount ----------------------------------------------------------

    def _discount_flow(self, run: dict, msg: InboundMessage, c: Classification) -> None:
        pct = c.requested_discount_percent
        decision = self.policy.decide(pct)
        run["discount"] = {"requested_pct": pct, "decision": decision.value}
        if decision == DiscountDecision.INVALID:
            return self._triage(run, msg, "discount requested without a valid percentage")

        contact = self._resolve_customer(run, msg, c)
        base = self._step(run, "load_base_quote", lambda: self._base_quote(run, msg, c, contact),
                          detail=lambda q: {"quote_id": q.id if q else None})

        self._step(run, "policy_check", lambda: decision.value,
                   detail=lambda d: {"requested_pct": pct, "decision": d,
                                     "approval_threshold_pct": str(self.policy.approval_threshold_pct),
                                     "decline_above_pct": str(self.policy.decline_above_pct)})

        # Declined whether or not there is a quote to discount.
        if decision == DiscountDecision.DECLINE:
            on_quote = f" on quote {base.id} ({_money(base.total_cents)})" if base else ""
            self._step(run, "notify_manager_declined", lambda: self._post_manager(
                f":no_entry: Declined a {_pct(pct)} discount request from {self._who(msg, base)}{on_quote}. "
                f"Requests above {_pct(self.policy.decline_above_pct)} are outside policy; "
                f"no quote was sent. Run {run['id']}."))
            run["status"] = "declined"
            return

        if base is None:
            return self._ask_for_details(
                run, msg, "We couldn't find an existing quote for you. Which plan and how many seats should we quote?")

        revised = self._step(run, "apply_discount", lambda: self._discounted_quote(base, Decimal(str(pct))),
                             detail=lambda q: {"quote_id": q.id, "discount_pct": q.discount_pct,
                                               "total": _money(q.total_cents)})

        if decision == DiscountDecision.AUTO_APPROVE:
            self._record_and_send(run, msg, revised, parent=base)
            run["status"] = "completed"
            return

        # NEEDS_APPROVAL: park the revised quote and ask a manager.
        revised.status = "pending_approval"
        self.store.save_quote(revised)
        approval_id = _new_id("APR")
        self.store.create_approval(approval_id, run["id"], {"quote_id": revised.id, "base_quote_id": base.id,
                                                            "requested_pct": pct})
        posted = self._step(run, "request_approval", lambda: self._request_approval(approval_id, msg, base, revised),
                            detail=lambda p: {"approval_id": approval_id, **p})
        self.store.update_approval_data(approval_id, {"quote_id": revised.id, "base_quote_id": base.id,
                                                      "requested_pct": pct, **posted})
        run["approval_id"] = approval_id
        run["quote_id"] = revised.id
        run["status"] = "awaiting_approval"

    def _finish_approval(self, run: dict, msg: InboundMessage, approval: dict, decision: str, by: str) -> None:
        revised = self.store.get_quote(approval["quote_id"])
        base = self.store.get_quote(approval["base_quote_id"])
        if decision == "approved":
            revised.status = "draft"
            self._record_and_send(run, msg, revised, parent=base)
            run["status"] = "completed"
            outcome = f":white_check_mark: Approved by <@{by}>. Quote {revised.id} ({_money(revised.total_cents)}) sent."
        else:
            self.store.save_quote(revised.model_copy(update={"status": "superseded"}))
            self._step(run, "notify_customer_rejected", lambda: self._notify_rejected(msg, base, approval))
            run["status"] = "rejected"
            outcome = f":x: Rejected by <@{by}>. Customer told quote {base.id} stands."
        if self.slack and approval.get("channel") and approval.get("ts"):
            self._step(run, "update_approval_message",
                       lambda: self.slack.update_message(approval["channel"], approval["ts"], outcome,
                                                         blocks=[{"type": "section", "text": {"type": "mrkdwn", "text": outcome}}])
                       and None)

    # ======================================================================
    # Steps
    # ======================================================================

    def _resolve_customer(self, run: dict, msg: InboundMessage, c: Classification) -> dict | None:
        if self.hubspot is None:
            return self._skip(run, "resolve_customer", "HubSpot not configured")
        first, last = _split_name(c.customer_name or msg.sender_name)
        contact = self._step(run, "resolve_customer",
                             lambda: self.hubspot.ensure_contact(msg.sender_email, first, last),
                             detail=lambda ct: {"hubspot_contact_id": ct.get("id")})
        return contact

    def _price_new_quote(self, run: dict, msg: InboundMessage, c: Classification, contact: dict | None) -> Quote:
        priced = self._step(run, "price", lambda: self.pricing.price(c.items),
                            detail=lambda p: {"subtotal": _money(p.subtotal_cents), "lines": len(p.lines)})
        props = (contact or {}).get("properties") or {}
        created = datetime.now(timezone.utc)
        return Quote(
            id=_new_id("Q"),
            customer_email=msg.sender_email,
            customer_name=" ".join(filter(None, [props.get("firstname"), props.get("lastname")]))
            or c.customer_name or msg.sender_name,
            company=props.get("company") or None,
            hubspot_contact_id=(contact or {}).get("id"),
            currency=priced.currency,
            lines=priced.lines,
            subtotal_cents=priced.subtotal_cents,
            total_cents=priced.subtotal_cents,
            created_at=created.isoformat(timespec="seconds"),
            valid_until=(created + timedelta(days=self.s.quote_valid_days)).date().isoformat(),
        )

    def _base_quote(self, run: dict, msg: InboundMessage, c: Classification, contact: dict | None) -> Quote | None:
        """The quote the discount applies to: the one referenced, else the latest sent, else a fresh one."""
        if c.referenced_quote_id:
            q = self.store.get_quote(c.referenced_quote_id)
            # Only the customer the quote was issued to may renegotiate it.
            if q and q.customer_email.lower() == msg.sender_email.lower() and q.status == "sent":
                return q
        latest = self.store.latest_sent_quote(msg.sender_email)
        if latest:
            return latest
        if c.items:
            fresh = self._price_new_quote(run, msg, c, contact)
            self.store.save_quote(fresh)  # kept as draft so a rejection can still send list price
            return fresh
        return None

    def _discounted_quote(self, base: Quote, pct: Decimal) -> Quote:
        discount, total = apply_discount(base.subtotal_cents, pct)
        created = datetime.now(timezone.utc)
        is_revision = base.status == "sent"
        return base.model_copy(update={
            "id": _new_id("Q"),
            "version": base.version + 1 if is_revision else base.version,
            "parent_quote_id": base.id,
            "discount_pct": float(pct),
            "discount_cents": discount,
            "total_cents": total,
            "status": "draft",
            "created_at": created.isoformat(timespec="seconds"),
            "valid_until": (created + timedelta(days=self.s.quote_valid_days)).date().isoformat(),
        })

    def _record_and_send(self, run: dict, msg: InboundMessage, quote: Quote, parent: Quote | None = None) -> None:
        if self.hubspot is not None and quote.hubspot_contact_id and self.s.hubspot_record_deals:
            def record():
                name = f"{quote.company or quote.customer_email} — {quote.id}"
                if quote.hubspot_deal_id:
                    return self.hubspot.update_deal_amount(quote.hubspot_deal_id, amount_cents=quote.total_cents, name=name)
                return self.hubspot.create_deal(name=name, amount_cents=quote.total_cents,
                                                contact_id=quote.hubspot_contact_id,
                                                pipeline=self.s.hubspot_pipeline, stage=self.s.hubspot_deal_stage)
            deal = self._step(run, "record_crm", record, detail=lambda d: {"hubspot_deal_id": d.get("id"),
                                                                           "amount": d["properties"].get("amount")})
            quote.hubspot_deal_id = deal.get("id")
        else:
            self._skip(run, "record_crm", "HubSpot deals disabled, not configured, or no contact")

        self.store.save_quote(quote)  # persisted before sending: a send failure leaves a draft, never a ghost
        subject, body = self._render_quote(quote, msg)
        self._step(run, "send_quote", lambda: self._reply(msg, subject, body), detail=lambda r: r)
        quote.status = "sent"
        self.store.save_quote(quote)
        if parent is not None and parent.status == "sent":
            self.store.save_quote(parent.model_copy(update={"status": "superseded"}))
        run["quote_id"] = quote.id

    def _request_approval(self, approval_id: str, msg: InboundMessage, base: Quote, revised: Quote) -> dict:
        if self.slack is None or not self.s.slack_manager_channel:
            raise RuntimeError("Slack manager channel is not configured; cannot request approval")
        text = (f"*Discount approval needed* — {self._who(msg, base)} asked for *{_pct(revised.discount_pct)}* "
                f"off quote {base.id}.\n"
                f"Subtotal {_money(revised.subtotal_cents)} → *{_money(revised.total_cents)}* "
                f"(−{_money(revised.discount_cents)}).\n"
                f"Policy: {_pct(self.policy.approval_threshold_pct)}–{_pct(self.policy.decline_above_pct)} "
                f"needs manager approval.\n>{_quote_text(msg.text)}")
        blocks = [
            {"type": "section", "text": {"type": "mrkdwn", "text": text}},
            {"type": "actions", "block_id": "discount_approval", "elements": [
                {"type": "button", "action_id": "discount_approve", "style": "primary", "value": approval_id,
                 "text": {"type": "plain_text", "text": "Approve"}},
                {"type": "button", "action_id": "discount_reject", "style": "danger", "value": approval_id,
                 "text": {"type": "plain_text", "text": "Reject"}},
            ]},
        ]
        posted = self.slack.post_message(self.s.slack_manager_channel, text, blocks=blocks)
        return {"channel": posted["channel"], "ts": posted["ts"]}

    def _notify_rejected(self, msg: InboundMessage, base: Quote, approval: dict) -> dict:
        if base.status == "sent":
            body = (f"Thanks for your patience. We reviewed your request for {_pct(approval['requested_pct'])} off, "
                    f"but we aren't able to offer that discount. Quote {base.id} for {_money(base.total_cents)} "
                    f"is still valid until {base.valid_until}.")
            return self._reply(msg, f"Re: quote {base.id}", body)
        # The base quote was never sent (discount asked on a fresh request) — send it at list price.
        base.status = "draft"
        subject, body = self._render_quote(base, msg, preface=(
            f"We reviewed your request for {_pct(approval['requested_pct'])} off but can't offer that discount. "
            f"Here is our standard pricing:"))
        result = self._reply(msg, subject, body)
        base.status = "sent"
        self.store.save_quote(base)
        return result

    def _triage(self, run: dict, msg: InboundMessage, reason: str) -> None:
        self._step(run, "triage", lambda: self._post_manager(
            f":mag: Message needs a human ({reason}) — from {msg.sender_email or 'unknown sender'} "
            f"via {msg.channel}. Run {run['id']}.\n>{_quote_text(msg.text)}") if self.slack and self.s.slack_manager_channel
            else {"skipped": "no Slack manager channel"}, detail=lambda r: {"reason": reason})
        run["status"] = "triaged"

    def _ask_for_details(self, run: dict, msg: InboundMessage, question: str) -> None:
        self._step(run, "ask_for_details", lambda: self._reply(msg, f"Re: {msg.subject or 'your quote request'}",
                                                               f"Thanks for reaching out! {question}"))
        run["status"] = "needs_info"

    # ======================================================================
    # Channels
    # ======================================================================

    def _reply(self, msg: InboundMessage, subject: str, body: str) -> dict:
        ref = msg.reply_ref
        if msg.channel == "slack":
            if self.slack is None:
                raise RuntimeError("Slack is not configured")
            posted = self.slack.post_message(ref["channel"], body, thread_ts=ref.get("thread_ts"))
            return {"channel": "slack", "ts": posted.get("ts")}
        if self.gmail is None:
            raise RuntimeError("Gmail is not configured")
        orig = ref.get("subject") or ""
        subj = orig if orig.lower().startswith("re:") else (f"Re: {orig}" if orig else subject)
        sent = self.gmail.send(to=msg.sender_email, subject=subj, body=body, sender=self.s.gmail_address,
                               thread_id=ref.get("thread_id"), in_reply_to=ref.get("message_id_header"))
        return {"channel": "email", "gmail_id": sent.get("id")}

    def _post_manager(self, text: str) -> dict:
        if self.slack is None or not self.s.slack_manager_channel:
            raise RuntimeError("Slack manager channel is not configured")
        posted = self.slack.post_message(self.s.slack_manager_channel, text)
        return {"channel": posted["channel"], "ts": posted["ts"]}

    def _render_quote(self, q: Quote, msg: InboundMessage, preface: str | None = None) -> tuple[str, str]:
        name = (q.customer_name or "there").split()[0]
        lines = [f"Hi {name},", "", preface or "Thanks for your interest — here is your quote.", "",
                 f"Quote {q.id}" + (f" (revision {q.version}, replaces {q.parent_quote_id})" if q.version > 1 else ""),
                 ""]
        for l in q.lines:
            lines.append(f"  {l.name}: {l.quantity} × {_money(l.unit_price_cents)} = {_money(l.line_total_cents)}")
            if l.note:
                lines.append(f"    ({l.note})")
        lines += ["", f"  Subtotal: {_money(q.subtotal_cents)}"]
        if q.discount_cents:
            lines.append(f"  Discount ({_pct(q.discount_pct)}): −{_money(q.discount_cents)}")
        lines += [f"  Total ({q.currency}): {_money(q.total_cents)}", "",
                  f"This quote is valid until {q.valid_until}. Reply to this message to accept or ask questions.",
                  "", f"— {self.s.company_name} Sales"]
        return f"Your {self.s.company_name} quote {q.id}", "\n".join(lines)

    @staticmethod
    def _who(msg: InboundMessage, q: Quote | None) -> str:
        who = (q and q.customer_name) or msg.sender_name or msg.sender_email
        return f"{who} <{msg.sender_email}>" + (f" ({q.company})" if q and q.company else "")

    # ======================================================================
    # Step bookkeeping
    # ======================================================================

    def _step(self, run: dict, name: str, fn: Callable[[], Any], detail: Callable[[Any], Any] | None = None) -> Any:
        rec = {"name": name, "status": "running", "started_at": now_iso()}
        run["steps"].append(rec)
        self.store.save_run(run)
        try:
            result = fn()
        except Exception as exc:
            rec.update(status="error", error=f"{type(exc).__name__}: {exc}", finished_at=now_iso())
            self.store.save_run(run)
            raise
        rec.update(status="ok", finished_at=now_iso())
        if detail is not None:
            rec["detail"] = detail(result)
        self.store.save_run(run)
        return result

    def _skip(self, run: dict, name: str, reason: str) -> None:
        run["steps"].append({"name": name, "status": "skipped", "detail": {"reason": reason}, "started_at": now_iso()})
        self.store.save_run(run)
        return None

    def _guard(self, run: dict, body: Callable[[], None]) -> dict:
        try:
            body()
        except Exception as exc:
            log.exception("run %s failed", run["id"])
            run["status"] = "failed"
            run["error"] = f"{type(exc).__name__}: {exc}"
            try:
                if self.slack and self.s.slack_manager_channel:
                    self._post_manager(f":warning: Quote workflow run {run['id']} failed: {run['error']}")
            except Exception:
                log.exception("could not alert manager about failed run %s", run["id"])
        self.store.save_run(run)
        return run


def _split_name(name: str | None) -> tuple[str | None, str | None]:
    if not name:
        return None, None
    parts = name.strip().split(maxsplit=1)
    return parts[0], parts[1] if len(parts) > 1 else None


def _quote_text(text: str, limit: int = 500) -> str:
    t = text.strip().replace("\n", "\n>")
    return t if len(t) <= limit else t[:limit] + "…"
