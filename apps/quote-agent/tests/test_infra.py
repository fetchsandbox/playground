"""Production plumbing: config validation, migrations, the SQS worker, scheduled jobs."""

import json
from datetime import datetime, timedelta, timezone

import boto3
import pytest
from conftest import MANAGER_CHANNEL, TEST_PG, sign
from fastapi.testclient import TestClient
from moto import mock_aws

from quote_agent.__main__ import main
from quote_agent.app import create_app
from quote_agent.config import ConfigError, Settings
from quote_agent.jobs import SqsQueue, gmail_watch
from quote_agent.worker import Worker


def test_suite_runs_on_the_configured_database(orch):
    assert orch.store.db.dialect == ("postgres" if TEST_PG else "sqlite")


# ------------------------------------------------------------------ config


def prod(**kw) -> Settings:
    base = dict(environment="production", database_url="postgresql://x/y", queue_backend="sqs",
                sqs_queue_url="https://sqs/q", anthropic_api_key="k")
    return Settings(**{**base, **kw})


def test_production_config_accepts_a_complete_setup():
    prod().validate("api")


@pytest.mark.parametrize("override,problem", [
    ({"database_url": ""}, "PostgreSQL"),
    ({"queue_backend": "inline"}, "QUEUE_BACKEND=sqs"),
    ({"dev_endpoints": True}, "DEV_ENDPOINTS"),
    ({"verifier_token": "t"}, "verifier"),
    ({"anthropic_api_key": None}, "ANTHROPIC_API_KEY"),
    ({"slack_bot_token": "x", "slack_manager_channel": "C1"}, "SLACK_SIGNING_SECRET"),
    ({"sqs_queue_url": ""}, "SQS_QUEUE_URL"),
])
def test_production_config_rejects_unsafe_settings(override, problem):
    with pytest.raises(ConfigError, match=problem):
        prod(**override).validate("api")


def test_database_url_assembled_from_rds_parts(monkeypatch):
    for k, v in {"DB_HOST": "db.internal", "DB_USER": "app", "DB_PASSWORD": "p@ss/word", "DB_NAME": "quotes"}.items():
        monkeypatch.setenv(k, v)
    s = Settings.from_env()
    assert s.database_url == "postgresql://app:p%40ss%2Fword@db.internal:5432/quotes?sslmode=require"


# -------------------------------------------------------------- migrations


def test_migrations_are_idempotent(orch):
    assert orch.store.migrate() == []
    assert orch.store.ping()


def test_migrate_command(tmp_path, monkeypatch):
    monkeypatch.setenv("QUOTE_AGENT_DB", str(tmp_path / "cli.db"))
    assert main(["migrate"]) == 0
    assert main(["migrate"]) == 0


def test_invalid_config_exits_nonzero(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    assert main(["migrate"]) == 2


# ------------------------------------------------------------ health / ready


def test_ready_reports_database_state(client, orch, monkeypatch):
    assert client.get("/ready").json() == {"ok": True, "database": True}
    monkeypatch.setattr(orch.store, "ping", lambda: False)
    assert client.get("/ready").status_code == 503
    assert client.get("/health").status_code == 200
    assert client.get("/health").headers["X-Request-Id"]


# ------------------------------------------------------------------ worker


@pytest.fixture
def sqs():
    with mock_aws():
        c = boto3.client("sqs", region_name="us-east-1")
        dlq = c.create_queue(QueueName="quote-jobs-dlq")["QueueUrl"]
        dlq_arn = c.get_queue_attributes(QueueUrl=dlq, AttributeNames=["QueueArn"])["Attributes"]["QueueArn"]
        url = c.create_queue(QueueName="quote-jobs", Attributes={
            "VisibilityTimeout": "0",
            "RedrivePolicy": json.dumps({"deadLetterTargetArn": dlq_arn, "maxReceiveCount": "2"})})["QueueUrl"]
        yield c, url, dlq


def test_webhook_enqueues_and_worker_processes(settings, orch, fake, sqs):
    c, url, _ = sqs
    settings.queue_backend, settings.sqs_queue_url = "sqs", url
    app = TestClient(create_app(settings, orch, queue=SqsQueue(url, client=c)))
    body = json.dumps({"type": "event_callback", "event_id": "EvQ1", "event": {
        "type": "message", "channel_type": "im", "channel": "D1", "user": "U_CUSTOMER",
        "text": "Quote for 5 seats of Starter please", "ts": "1700000009.000100"}}).encode()
    assert app.post("/webhooks/slack/events", content=body, headers=sign(body)).status_code == 200
    assert orch.store.list_runs() == []  # nothing ran in the request

    worker = Worker(orch, settings, client=c, wait_seconds=0)
    assert worker.poll_once() == 1
    [run] = orch.store.list_runs()
    assert run["status"] == "completed" and "$1,200.00" in fake.slack_posts[0]["text"]
    assert c.receive_message(QueueUrl=url).get("Messages") is None  # deleted after success


def test_failing_job_is_retried_then_dead_lettered(settings, orch, sqs, monkeypatch):
    c, url, dlq = sqs
    settings.queue_backend, settings.sqs_queue_url = "sqs", url
    SqsQueue(url, client=c).enqueue({"type": "gmail_push", "history_id": "9"})

    def boom(*_):
        raise RuntimeError("Gmail down")
    monkeypatch.setattr(orch.gmail, "new_message_ids", boom)
    worker = Worker(orch, settings, client=c, wait_seconds=0)
    assert worker.poll_once() == 0 and worker.poll_once() == 0  # two failed receives
    worker.poll_once()  # third receive: SQS has moved it to the DLQ
    assert c.receive_message(QueueUrl=dlq).get("Messages")


def test_duplicate_job_delivery_has_one_effect(settings, orch, fake, sqs):
    c, url, _ = sqs
    settings.queue_backend, settings.sqs_queue_url = "sqs", url
    job = {"type": "slack_event", "event_id": "EvDup", "event": {
        "type": "message", "channel_type": "im", "channel": "D1", "user": "U_CUSTOMER",
        "text": "Quote for 5 seats of Starter please", "ts": "1700000010.000100"}}
    q = SqsQueue(url, client=c)
    q.enqueue(job)
    q.enqueue(job)  # SQS standard queues can deliver twice
    worker = Worker(orch, settings, client=c, wait_seconds=0)
    while worker.poll_once():
        pass
    assert len(orch.store.list_runs()) == 1 and len(fake.slack_posts) == 1


# --------------------------------------------------------- scheduled jobs


def test_reaper_fails_interrupted_runs_and_alerts_manager(orch, fake):
    old = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(timespec="seconds")
    run = {"id": "RUN-STALE", "status": "running", "created_at": old, "steps": [{"name": "price", "status": "ok"}],
           "inbound": {"channel": "email", "sender_email": "a@b.test", "external_id": "x"}}
    orch.store.save_run(run)
    orch.store.db.execute("UPDATE runs SET updated_at = ? WHERE id = ?", (old, "RUN-STALE"))
    orch.store.save_run({**run, "id": "RUN-FRESH"})

    assert orch.reap_stale_runs(900) == ["RUN-STALE"]
    assert orch.store.get_run("RUN-STALE")["status"] == "failed"
    assert orch.store.get_run("RUN-FRESH")["status"] == "running"
    assert fake.slack_posts[-1]["channel"] == MANAGER_CHANNEL and "interrupted at step 'price'" in fake.slack_posts[-1]["text"]


def test_gmail_watch_renews_and_seeds_cursor(orch, settings, fake):
    settings.gmail_pubsub_topic = "projects/p/topics/gmail"
    gmail_watch(orch, settings)
    assert fake.gmail_watch == {"topicName": "projects/p/topics/gmail", "labelIds": ["INBOX"]}
    assert orch.store.get_kv("gmail_history_id") == "4242"
    orch.store.advance_kv_int("gmail_history_id", 10)  # never moves backwards
    assert orch.store.get_kv("gmail_history_id") == "4242"
