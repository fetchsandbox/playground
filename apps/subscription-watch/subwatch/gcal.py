"""Google Calendar: create the "cancel this subscription" reminder."""

from __future__ import annotations

import hashlib
from datetime import date, timedelta

import httpx

from .http import ProviderError, raise_for_google, send


def event_id_for(message_id: str) -> str:
    """Deterministic event id per Gmail message.

    Calendar accepts client-supplied ids (base32hex: 0-9, a-v) and answers 409
    if the id already exists, so a retried insert cannot create a second event.
    """
    return "sub" + hashlib.sha1(message_id.encode()).hexdigest()


class CalendarClient:
    def __init__(self, client: httpx.Client, calendar_id: str, max_retry_after: float):
        self._c = client
        self._calendar_id = calendar_id
        self._max_retry_after = max_retry_after

    def create_reminder(self, *, message_id: str, summary: str, description: str, day: date) -> str:
        event_id = event_id_for(message_id)
        body = {
            "id": event_id,
            "summary": summary,
            "description": description,
            "start": {"date": day.isoformat()},
            "end": {"date": (day + timedelta(days=1)).isoformat()},
            "transparency": "transparent",
            "reminders": {"useDefault": False, "overrides": [{"method": "popup", "minutes": 9 * 60}]},
            "extendedProperties": {"private": {"subwatchGmailMessageId": message_id}},
        }
        r = send(self._c, "google-calendar", "POST", f"/calendars/{self._calendar_id}/events",
                 json=body, max_retry_after=self._max_retry_after)
        if r.status_code == 409:
            return event_id  # created by an earlier attempt
        raise_for_google("google-calendar", r)
        created = r.json().get("id")
        if not created:
            raise ProviderError("google-calendar", "events.insert returned no id", r.status_code)
        return created
