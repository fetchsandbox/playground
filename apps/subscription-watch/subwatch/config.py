"""Settings, read once from the environment.

Every provider base URL defaults to the real vendor endpoint. Point them at a
test twin (or anything else that speaks the same API) by overriding the env.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_RULES = Path(__file__).resolve().parent.parent / "rules.json"


@dataclass(frozen=True)
class Settings:
    gmail_base_url: str = "https://gmail.googleapis.com"
    calendar_base_url: str = "https://www.googleapis.com/calendar/v3"
    slack_base_url: str = "https://slack.com"

    # Google auth: either a static access token, or a refresh token that is
    # exchanged for a short-lived access token on every run.
    google_access_token: str | None = None
    google_client_id: str | None = None
    google_client_secret: str | None = None
    google_refresh_token: str | None = None
    # Separate token for Calendar, only needed when Gmail and Calendar are
    # served by different hosts that issue their own keys (e.g. test twins).
    calendar_access_token: str | None = None

    slack_bot_token: str = ""
    slack_channel: str = ""

    gmail_user: str = "me"
    gmail_query: str = "in:inbox newer_than:2d"
    calendar_id: str = "primary"

    rules_path: Path = DEFAULT_RULES
    state_backend: str = "sqlite"  # sqlite | dynamodb
    sqlite_path: str = "subwatch.db"
    dynamodb_table: str = "subwatch-processed"

    # Shared secret the Gmail Pub/Sub push subscription must present.
    push_token: str | None = None
    # Extra headers sent on every provider request (e.g. a test run id).
    provider_extra_headers: dict[str, str] = field(default_factory=dict)
    http_timeout: float = 15.0
    max_retry_after: float = 20.0


def load_settings(env: dict[str, str] | None = None) -> Settings:
    e = os.environ if env is None else env
    extra = e.get("PROVIDER_EXTRA_HEADERS")
    return Settings(
        gmail_base_url=e.get("GMAIL_BASE_URL", Settings.gmail_base_url).rstrip("/"),
        calendar_base_url=e.get("CALENDAR_BASE_URL", Settings.calendar_base_url).rstrip("/"),
        slack_base_url=e.get("SLACK_BASE_URL", Settings.slack_base_url).rstrip("/"),
        google_access_token=e.get("GOOGLE_ACCESS_TOKEN") or None,
        google_client_id=e.get("GOOGLE_CLIENT_ID") or None,
        google_client_secret=e.get("GOOGLE_CLIENT_SECRET") or None,
        google_refresh_token=e.get("GOOGLE_REFRESH_TOKEN") or None,
        calendar_access_token=e.get("CALENDAR_ACCESS_TOKEN") or None,
        slack_bot_token=e.get("SLACK_BOT_TOKEN", ""),
        slack_channel=e.get("SLACK_CHANNEL", ""),
        gmail_user=e.get("GMAIL_USER", "me"),
        gmail_query=e.get("GMAIL_QUERY", Settings.gmail_query),
        calendar_id=e.get("CALENDAR_ID", "primary"),
        rules_path=Path(e.get("RULES_PATH", str(DEFAULT_RULES))),
        state_backend=e.get("STATE_BACKEND", "sqlite"),
        sqlite_path=e.get("SQLITE_PATH", "subwatch.db"),
        dynamodb_table=e.get("DYNAMODB_TABLE", "subwatch-processed"),
        push_token=e.get("PUSH_TOKEN") or None,
        provider_extra_headers=json.loads(extra) if extra else {},
        http_timeout=float(e.get("HTTP_TIMEOUT", "15")),
        max_retry_after=float(e.get("MAX_RETRY_AFTER", "20")),
    )
