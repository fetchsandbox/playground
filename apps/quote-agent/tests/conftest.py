import hashlib
import hmac
import os
import sys
import time
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fakes import GMAIL, GOOGLE_TOKEN, HUBSPOT, RESEND, SLACK, STRIPE, FakeProviders  # noqa: E402
from quote_agent.app import create_app  # noqa: E402
from quote_agent.classifier import IntentClassifier  # noqa: E402
from quote_agent.config import Settings  # noqa: E402
from quote_agent.handoff import build_handoff  # noqa: E402
from quote_agent.orchestrator import Orchestrator  # noqa: E402
from quote_agent.pricing import PricingClient  # noqa: E402
from quote_agent.providers.gmail import GmailClient  # noqa: E402
from quote_agent.providers.hubspot import HubSpotClient  # noqa: E402
from quote_agent.providers.slack import SlackClient  # noqa: E402
from quote_agent.store import Store  # noqa: E402

SIGNING_SECRET = "slack-signing-secret"
MANAGER = "U_MANAGER"
MANAGER_CHANNEL = "C_APPROVALS"
HANDOFF_TOKEN = "handoff-token"
ADMIN_TOKEN = "admin-token"
VERIFIER_TOKEN = "verifier-token"


@pytest.fixture
def fake():
    return FakeProviders()


# Set TEST_DATABASE_URL=postgresql://... to run the whole suite against PostgreSQL;
# each test gets its own schema. Otherwise tests use a fresh SQLite file.
TEST_PG = os.environ.get("TEST_DATABASE_URL", "")


@pytest.fixture
def db_url(tmp_path):
    if not TEST_PG:
        yield ""
        return
    import psycopg
    schema = "t_" + uuid.uuid4().hex[:12]
    with psycopg.connect(TEST_PG, autocommit=True) as c:
        c.execute(f"CREATE SCHEMA {schema}")
    yield f"{TEST_PG}{'&' if '?' in TEST_PG else '?'}options=-csearch_path%3D{schema}"
    with psycopg.connect(TEST_PG, autocommit=True) as c:
        c.execute(f"DROP SCHEMA {schema} CASCADE")


@pytest.fixture
def settings(tmp_path, db_url):
    return Settings(
        db_path=str(tmp_path / "test.db"),
        database_url=db_url,
        classifier="rules",
        hubspot_base_url=HUBSPOT, hubspot_token="hs-token",
        slack_base_url=SLACK, slack_bot_token="xoxb-test", slack_signing_secret=SIGNING_SECRET,
        slack_manager_channel=MANAGER_CHANNEL, slack_manager_user_ids=[MANAGER],
        gmail_base_url=GMAIL, gmail_token_url=GOOGLE_TOKEN, gmail_access_token="gm-token",
        gmail_address="sales@northwind.test", gmail_push_token="push-secret",
        stripe_base_url=STRIPE, stripe_secret_key="sk_test_fake",
        resend_base_url=RESEND, resend_api_key="re_fake", handoff_from_email="welcome@northwind.test",
        handoff_api_token=HANDOFF_TOKEN,
        dev_endpoints=True,
    )


def _migrated(store):
    store.migrate()
    return store


@pytest.fixture
def orch(settings, fake):
    http = fake.client()
    o = Orchestrator(
        settings=settings,
        store=_migrated(Store(settings.db_url)),
        classifier=IntentClassifier(None),
        pricing=PricingClient(),
        hubspot=HubSpotClient(HUBSPOT, "hs-token", http=http),
        slack=SlackClient(SLACK, "xoxb-test", http=http),
        gmail=GmailClient(base_url=GMAIL, token_url=GOOGLE_TOKEN, access_token="gm-token", http=http),
    )
    o.handoff, o.research = build_handoff(settings, o.store, http=http)
    yield o
    o.store.db.close()


@pytest.fixture
def client(settings, orch):
    return TestClient(create_app(settings, orch))


def sign(body: bytes, ts: int | None = None, secret: str = SIGNING_SECRET) -> dict:
    ts = str(ts if ts is not None else int(time.time()))
    sig = "v0=" + hmac.new(secret.encode(), f"v0:{ts}:".encode() + body, hashlib.sha256).hexdigest()
    return {"X-Slack-Request-Timestamp": ts, "X-Slack-Signature": sig}
