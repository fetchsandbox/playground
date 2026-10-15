"""SQS worker: long-polls the job queue and runs each job.

A message is deleted only after its job finishes. If a job raises, the
message becomes visible again after the queue's visibility timeout and is
retried; after maxReceiveCount attempts SQS moves it to the dead-letter
queue (alarmed in CloudWatch). SIGTERM (ECS stopping the task) finishes the
current batch and exits.
"""

import json
import logging
import signal
from typing import Any

from .config import Settings
from .jobs import run_job
from .logging_setup import request_id
from .orchestrator import Orchestrator

log = logging.getLogger(__name__)


class Worker:
    def __init__(self, orch: Orchestrator, settings: Settings, client: Any = None, *,
                 wait_seconds: int = 20, batch_size: int = 5):
        import boto3
        self.orch = orch
        self.s = settings
        self.client = client or boto3.client("sqs", region_name=settings.aws_region or None)
        self.wait_seconds = wait_seconds
        self.batch_size = batch_size
        self._stopping = False

    def stop(self, *_: Any) -> None:
        log.info("worker stopping after current batch")
        self._stopping = True

    def run_forever(self) -> None:
        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT, self.stop)
        log.info("worker polling %s", self.s.sqs_queue_url)
        while not self._stopping:
            self.poll_once()

    def poll_once(self) -> int:
        """Receive and process one batch. Returns the number of jobs that succeeded."""
        resp = self.client.receive_message(
            QueueUrl=self.s.sqs_queue_url, MaxNumberOfMessages=self.batch_size,
            WaitTimeSeconds=self.wait_seconds, AttributeNames=["ApproximateReceiveCount"],
        )
        done = 0
        for msg in resp.get("Messages", []):
            token = request_id.set(msg["MessageId"])
            try:
                job = json.loads(msg["Body"])
                run_job(self.orch, self.s, job)
            except Exception:  # noqa: BLE001 — leave the message for retry / DLQ
                log.exception("job failed (receive count %s); it will be retried",
                              msg.get("Attributes", {}).get("ApproximateReceiveCount"))
                continue
            finally:
                request_id.reset(token)
            self.client.delete_message(QueueUrl=self.s.sqs_queue_url, ReceiptHandle=msg["ReceiptHandle"])
            done += 1
        return done
