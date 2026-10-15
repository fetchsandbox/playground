"""The workflow: new Gmail message -> rules -> Slack alert + Calendar reminder.

Run it on a schedule, on a Gmail push notification, or both: every run looks
at recent inbox messages and only acts on those it has not finished yet.
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timezone
from typing import Any

import httpx

from .config import Settings
from .gcal import CalendarClient
from .gmail import GmailClient
from .google_auth import google_access_token
from .http import ProviderError
from .rules import Match, RuleSet, evaluate
from .slack import SlackClient
from .store import Record, Store

log = logging.getLogger("subwatch")

MAX_ATTEMPTS = 5
DONE = {"completed", "ignored", "unparsable", "gave_up"}


@dataclass
class RunReport:
    listed: int = 0
    already_done: int = 0
    ignored: int = 0
    unparsable: int = 0
    completed: list[str] = field(default_factory=list)
    failed: list[dict[str, Any]] = field(default_factory=list)
    aborted: str | None = None


@dataclass
class Clients:
    gmail: GmailClient
    slack: SlackClient
    calendar: CalendarClient
    _http: list[httpx.Client]

    def close(self) -> None:
        for c in self._http:
            c.close()


def build_clients(settings: Settings, transport: httpx.BaseTransport | None = None) -> Clients:
    google_token = google_access_token(settings)
    calendar_token = settings.calendar_access_token or google_token

    def http(base: str, token: str) -> httpx.Client:
        return httpx.Client(
            base_url=base,
            headers={"Authorization": f"Bearer {token}", **settings.provider_extra_headers},
            timeout=settings.http_timeout,
            transport=transport,
        )

    g = http(settings.gmail_base_url, google_token)
    c = http(settings.calendar_base_url, calendar_token)
    s = http(settings.slack_base_url, settings.slack_bot_token)
    return Clients(
        gmail=GmailClient(g, settings.gmail_user, settings.max_retry_after),
        slack=SlackClient(s, settings.slack_channel, settings.max_retry_after),
        calendar=CalendarClient(c, settings.calendar_id, settings.max_retry_after),
        _http=[g, c, s],
    )


def run_once(settings: Settings, store: Store, ruleset: RuleSet, clients: Clients, today: date | None = None) -> RunReport:
    report = RunReport()
    ids = clients.gmail.list_message_ids(settings.gmail_query)
    report.listed = len(ids)
    for message_id in ids:
        record = store.get(message_id)
        if record and record["status"] in DONE:
            report.already_done += 1
            continue
        record = record or {"message_id": message_id, "attempts": 0}
        try:
            _process(message_id, record, store, ruleset, clients, report, today)
        except ProviderError as exc:
            record["attempts"] = record.get("attempts", 0) + 1
            record["status"] = "gave_up" if record["attempts"] >= MAX_ATTEMPTS else "failed"
            record["error"] = str(exc)
            record["retryable"] = exc.retryable
            _save(store, record)
            report.failed.append({"message_id": message_id, "error": str(exc), "retryable": exc.retryable})
            log.warning("message %s failed: %s", message_id, exc)
            # Auth or quota problems on Gmail affect every remaining message too.
            if exc.provider == "gmail" and exc.status in (401, 403, 429):
                report.aborted = str(exc)
                break
    return report


def _process(message_id: str, record: Record, store: Store, ruleset: RuleSet,
             clients: Clients, report: RunReport, today: date | None) -> None:
    if "rule" not in record:
        msg = clients.gmail.get_message(message_id)
        if msg is None:
            record["status"] = "unparsable"
            _save(store, record)
            report.unparsable += 1
            return
        match = evaluate(ruleset, msg, today=today)
        record.update(subject=msg.subject, sender=msg.sender_address,
                      received_at=msg.date.timestamp() if msg.date else None)
        if match is None:
            record["status"] = "ignored"
            _save(store, record)
            report.ignored += 1
            return
        record.update(_match_fields(match))
        record["status"] = "matched"
        _save(store, record)

    # The two actions are independent: a Slack outage must not cost the reminder,
    # and each one is saved as soon as it lands so a retry only redoes the other.
    errors: list[ProviderError] = []
    if not record.get("slack_ts"):
        try:
            # An earlier attempt may have posted without us recording it (lost
            # response or lost state); adopt that message instead of re-posting.
            received = record.get("received_at")
            existing = clients.slack.find_posted(gmail_link(message_id),
                                                 oldest=received - 86400 if received else None)
            record["slack_ts"] = existing or clients.slack.post(slack_text(record))
            _save(store, record)
        except ProviderError as exc:
            errors.append(exc)

    if not record.get("calendar_event_id"):
        try:
            record["calendar_event_id"] = clients.calendar.create_reminder(
                message_id=message_id,
                summary=f"Cancel {record['vendor']} subscription?",
                description=calendar_description(record),
                day=date.fromisoformat(record["reminder_date"]),
            )
            _save(store, record)
        except ProviderError as exc:
            errors.append(exc)

    if len(errors) == 1:
        raise errors[0]
    if errors:
        raise ProviderError("slack+calendar", "; ".join(str(e) for e in errors),
                            retryable=any(e.retryable for e in errors))
    record["status"] = "completed"
    record.pop("error", None)
    record.pop("retryable", None)
    _save(store, record)
    report.completed.append(message_id)
    log.info("message %s: slack ts=%s calendar event=%s", message_id, record["slack_ts"], record["calendar_event_id"])


def _match_fields(m: Match) -> dict[str, Any]:
    d = asdict(m)
    d["renewal_date"] = m.renewal_date.isoformat() if m.renewal_date else None
    d["reminder_date"] = m.reminder_date.isoformat()
    return d


def _save(store: Store, record: Record) -> None:
    record["updated_at"] = datetime.now(timezone.utc).isoformat()
    store.put(record)


def gmail_link(message_id: str) -> str:
    return f"https://mail.google.com/mail/u/0/#all/{message_id}"


def slack_text(r: Record) -> str:
    lines = [
        f":credit_card: *Subscription charge detected: {r['vendor']}*",
        f"• Amount: {r.get('amount') or 'not stated'}",
        f"• Renews: {r.get('renewal_date') or 'not stated'}",
        f"• Email: \"{r.get('subject', '')}\" from {r.get('sender', '')}",
        f"• Reminder to cancel: *{r['reminder_date']}* (Google Calendar)",
        f"<{gmail_link(r['message_id'])}|Open in Gmail>",
    ]
    return "\n".join(lines)


def calendar_description(r: Record) -> str:
    return (
        f"Decide whether to keep or cancel your {r['vendor']} subscription.\n\n"
        f"Amount: {r.get('amount') or 'not stated'}\n"
        f"Renews: {r.get('renewal_date') or 'not stated'}\n"
        f"Email: {r.get('subject', '')} ({r.get('sender', '')})\n"
        f"{gmail_link(r['message_id'])}\n\n"
        "Created by subscription-watch."
    )

