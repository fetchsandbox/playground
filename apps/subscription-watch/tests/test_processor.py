from datetime import date

import pytest

from subwatch.config import DEFAULT_RULES, Settings
from subwatch.gcal import event_id_for
from subwatch.processor import build_clients, run_once
from subwatch.rules import load_rules
from subwatch.store import SqliteStore
from tests.fakes import FakeProviders, raw_email

TODAY = date(2026, 10, 13)
NETFLIX = raw_email("Netflix <info@account.netflix.com>", "Your Netflix subscription payment receipt",
                    "Your monthly subscription of $15.49 was charged. Next billing date: November 13, 2026.")
DINNER = raw_email("Mom <mom@example.test>", "Dinner sunday?", "Bring dessert")


@pytest.fixture
def env(tmp_path):
    fake = FakeProviders()
    settings = Settings(
        gmail_base_url="https://gmail.test", calendar_base_url="https://calendar.test",
        slack_base_url="https://slack.test", google_access_token="g", slack_bot_token="xoxb-test",
        slack_channel="C0BILLING01", max_retry_after=1,
    )
    store = SqliteStore(str(tmp_path / "s.db"))
    rules = load_rules(DEFAULT_RULES)

    def run():
        clients = build_clients(settings, transport=fake.transport())
        try:
            return run_once(settings, store, rules, clients, today=TODAY)
        finally:
            clients.close()

    return fake, store, run


def test_matching_email_posts_to_slack_and_creates_reminder(env):
    fake, store, run = env
    fake.add("m-netflix", NETFLIX)
    fake.add("m-dinner", DINNER)
    fake.add("m-junk", "sample-value")

    report = run()

    assert report.completed == ["m-netflix"]
    assert report.ignored == 1 and report.unparsable == 1
    [post] = fake.slack_posts
    assert post["channel"] == "C0BILLING01"
    assert "Netflix" in post["text"] and "$15.49" in post["text"] and "2026-11-10" in post["text"]
    [event] = fake.events.values()
    assert event["id"] == event_id_for("m-netflix")
    assert event["summary"] == "Cancel Netflix subscription?"
    assert event["start"] == {"date": "2026-11-10"}
    rec = store.get("m-netflix")
    assert rec["status"] == "completed" and rec["slack_ts"] and rec["calendar_event_id"]


def test_rerun_does_not_duplicate(env):
    fake, _, run = env
    fake.add("m-netflix", NETFLIX)
    run()
    report = run()
    assert report.completed == [] and report.already_done == 1
    assert len(fake.slack_posts) == 1 and len(fake.events) == 1


def test_slack_ok_false_is_a_failure_but_reminder_still_lands(env):
    fake, store, run = env
    fake.add("m-netflix", NETFLIX)
    fake.slack_error = "not_in_channel"

    report = run()

    assert report.completed == []
    assert report.failed[0]["retryable"] is False and "not_in_channel" in report.failed[0]["error"]
    assert fake.slack_posts == []
    assert len(fake.events) == 1  # the reminder does not depend on Slack
    rec = store.get("m-netflix")
    assert rec["status"] == "failed" and rec["calendar_event_id"] and not rec.get("slack_ts")

    fake.slack_error = None  # bot invited to the channel
    assert run().completed == ["m-netflix"]
    assert len(fake.slack_posts) == 1 and len(fake.events) == 1


def test_both_actions_failing_reports_both(env):
    fake, store, run = env
    fake.add("m-netflix", NETFLIX)
    fake.slack_error = "channel_not_found"
    fake.calendar_status = 503
    [failure] = run().failed
    assert "channel_not_found" in failure["error"] and "503" in failure["error"]
    assert failure["retryable"] is True  # calendar side is worth retrying


def test_calendar_failure_retries_only_calendar(env):
    fake, store, run = env
    fake.add("m-netflix", NETFLIX)
    fake.calendar_status = 503

    report = run()
    assert report.failed and report.failed[0]["retryable"] is True
    assert len(fake.slack_posts) == 1
    assert store.get("m-netflix")["slack_ts"]

    fake.calendar_status = None
    assert run().completed == ["m-netflix"]
    assert len(fake.slack_posts) == 1  # not re-posted
    assert len(fake.events) == 1


def test_calendar_409_counts_as_created(env):
    fake, store, run = env
    fake.add("m-netflix", NETFLIX)
    fake.events[event_id_for("m-netflix")] = {"id": event_id_for("m-netflix")}
    assert run().completed == ["m-netflix"]
    assert store.get("m-netflix")["calendar_event_id"] == event_id_for("m-netflix")


def test_slack_429_is_retried_once_after_retry_after(env):
    fake, _, run = env
    fake.add("m-netflix", NETFLIX)
    fake.slack_429_once = True
    assert run().completed == ["m-netflix"]
    assert len(fake.slack_posts) == 1


def test_gmail_auth_failure_on_message_aborts_run(env):
    fake, store, run = env
    fake.add("a", NETFLIX)
    fake.add("b", NETFLIX)
    listing = fake._handle

    def revoke_after_list(req):
        if req.url.path.endswith("/messages/a"):
            fake.gmail_status = 401  # token revoked between list and get
        return listing(req)

    fake._handle = revoke_after_list
    report = run()

    assert report.aborted and "401" in report.aborted
    assert len(report.failed) == 1
    assert store.get("b") is None  # not touched; picked up on the next run
    assert fake.slack_posts == []
