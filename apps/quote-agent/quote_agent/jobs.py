"""Background jobs and the queues that carry them.

Webhook handlers only verify, then enqueue a small JSON job; the worker runs
it. In production the queue is SQS (at-least-once delivery, redrive to a
dead-letter queue after repeated failures). Locally the inline queue runs the
job in the same process, which keeps tests and development simple.

Jobs are safe to run more than once: inbound messages are claimed in the
database before any side effect, and approval decisions are atomic.

    {"type": "slack_event", "event_id": "...", "event": {...}}
    {"type": "gmail_push", "history_id": "123"}
    {"type": "approval_decision", "approval_id": "APR-...", "decision": "approved", "user_id": "U..."}
    {"type": "handoff_advance", "run_id": "HND-...", "agent": "billing"}

Handoff jobs carry the agent that runs the next step. With AGENT_QUEUE_URLS
set, each goes to that agent's own queue, so every agent can be its own
worker service; otherwise they share SQS_QUEUE_URL.
"""

import json
import logging
from typing import Any, Callable, Protocol

from .config import Settings
from .models import InboundMessage
from .orchestrator import Orchestrator
from .providers.gmail import GmailError
from .providers.slack import SlackError

log = logging.getLogger(__name__)


class JobQueue(Protocol):
    def enqueue(self, job: dict[str, Any]) -> None: ...


class InlineQueue:
    """Runs each job immediately in the calling process (development and tests)."""

    def __init__(self, handler: Callable[[dict[str, Any]], None]):
        self.handler = handler

    def enqueue(self, job: dict[str, Any]) -> None:
        try:
            self.handler(job)
        except Exception:  # noqa: BLE001 — mirror SQS: a failed job never fails the webhook
            log.exception("inline job failed: %s", job.get("type"))


class SqsQueue:
    def __init__(self, queue_url: str, region: str | None = None, client: Any = None):
        import boto3
        self.queue_url = queue_url
        self.client = client or boto3.client("sqs", region_name=region or None)

    def enqueue(self, job: dict[str, Any]) -> None:
        self.client.send_message(QueueUrl=self.queue_url, MessageBody=json.dumps(job),
                                 MessageAttributes={"type": {"DataType": "String", "StringValue": job["type"]}})


class AgentRoutingQueue:
    """Sends handoff jobs to their agent's queue, everything else to the default queue."""

    def __init__(self, default: JobQueue, per_agent: dict[str, JobQueue]):
        self.default = default
        self.per_agent = per_agent

    def enqueue(self, job: dict[str, Any]) -> None:
        self.per_agent.get(job.get("agent", ""), self.default).enqueue(job)


def build_queue(s: Settings, orch: Orchestrator) -> JobQueue:
    if s.queue_backend == "sqs":
        default = SqsQueue(s.sqs_queue_url, s.aws_region)
        queue: JobQueue = AgentRoutingQueue(default, {a: SqsQueue(url, s.aws_region)
                                                      for a, url in s.agent_queue_urls.items()})
    else:
        queue = InlineQueue(lambda job: run_job(orch, s, job))
    if orch.handoff is not None:
        orch.handoff.enqueue = queue.enqueue
    return queue


# ---------------------------------------------------------------------- jobs


def run_job(orch: Orchestrator, s: Settings, job: dict[str, Any]) -> None:
    kind = job.get("type")
    if kind == "slack_event":
        process_slack_event(orch, job["event_id"], job["event"])
    elif kind == "gmail_push":
        process_gmail(orch, s, str(job.get("history_id") or ""))
    elif kind == "approval_decision":
        try:
            orch.resume_approval(job["approval_id"], job["decision"], job["user_id"])
        except KeyError:
            log.warning("unknown approval %s", job["approval_id"])
    elif kind == "handoff_advance":
        if orch.handoff is None:
            raise RuntimeError("handoff job received but the handoff is not configured")
        orch.handoff.advance(job["run_id"], job.get("agent"))
    else:
        log.error("dropping unknown job type %r", kind)


def process_slack_event(orch: Orchestrator, event_id: str, event: dict) -> None:
    email, name = None, None
    try:
        profile = orch.slack.user_profile(event["user"]) if orch.slack else {}
        email = (profile.get("email") or "").lower() or None
        name = profile.get("real_name") or profile.get("display_name") or None
    except SlackError as exc:
        log.warning("could not look up Slack user %s: %s", event.get("user"), exc)
    orch.handle_inbound(InboundMessage(
        channel="slack",
        external_id=event_id,
        sender_email=email,
        sender_name=name,
        text=event.get("text", ""),
        reply_ref={"channel": event["channel"], "ts": event["ts"], "thread_ts": event.get("thread_ts") or event["ts"],
                   "user": event.get("user")},
    ))


def process_gmail(orch: Orchestrator, s: Settings, history_id: str) -> None:
    if orch.gmail is None:
        log.error("Gmail push received but Gmail is not configured")
        return
    cursor = orch.store.get_kv("gmail_history_id")
    # A failure here raises: the job is retried by the queue rather than silently skipping mail.
    ids = orch.gmail.new_message_ids(cursor)
    for mid in ids:
        try:
            m = orch.gmail.get_message(mid)
        except GmailError as exc:
            log.error("Gmail message %s fetch failed: %s", mid, exc)
            continue
        if "SENT" in m["labels"] or (s.gmail_address and m["from_email"] == s.gmail_address.lower()):
            continue  # our own replies land in the same thread
        orch.handle_inbound(InboundMessage(
            channel="email",
            external_id=m["id"],
            sender_email=m["from_email"],
            sender_name=m["from_name"],
            subject=m["subject"],
            text=m["text"],
            reply_ref={"thread_id": m["thread_id"], "message_id_header": m["message_id_header"],
                       "subject": m["subject"]},
        ))
    if history_id.isdigit():
        orch.store.advance_kv_int("gmail_history_id", int(history_id))


# ------------------------------------------------------------ scheduled jobs


def gmail_watch(orch: Orchestrator, s: Settings) -> dict:
    """Renew the Gmail push subscription (watches expire after 7 days; run daily)."""
    if orch.gmail is None or not s.gmail_pubsub_topic:
        raise RuntimeError("gmail-watch needs Gmail credentials and GMAIL_PUBSUB_TOPIC")
    resp = orch.gmail.watch(s.gmail_pubsub_topic)
    if orch.store.get_kv("gmail_history_id") is None and resp.get("historyId"):
        orch.store.set_kv("gmail_history_id", str(resp["historyId"]))
    log.info("gmail watch renewed until %s", resp.get("expiration"))
    return resp
