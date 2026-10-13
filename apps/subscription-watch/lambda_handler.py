"""AWS Lambda entry point.

Invoked two ways (see template.yaml):
  * EventBridge schedule: sweep the inbox every few minutes.
  * Lambda Function URL:  Gmail Pub/Sub push -> POST /gmail/push?token=...
"""

from __future__ import annotations

import base64
import json
import logging
import os
from typing import Any

from subwatch.config import load_settings
from subwatch.http import ProviderError
from subwatch.service import describe_push, push_authorized, run
from subwatch.store import make_store

logging.getLogger().setLevel(logging.INFO)
log = logging.getLogger("subwatch")


def _load_secrets() -> None:
    """Merge the JSON secret named by SECRETS_ARN into the environment."""
    arn = os.environ.get("SECRETS_ARN")
    if not arn:
        return
    import boto3

    secret = boto3.client("secretsmanager").get_secret_value(SecretId=arn)["SecretString"]
    for k, v in json.loads(secret).items():
        os.environ.setdefault(k, str(v))


_load_secrets()
settings = load_settings()
store = make_store(settings.state_backend, settings.sqlite_path, settings.dynamodb_table)


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    http = (event.get("requestContext") or {}).get("http")
    if http is None:
        report = run(settings, store)  # scheduled sweep: let failures surface in CloudWatch
        log.info("scheduled run: %s", json.dumps(report))
        return report

    if http.get("method") != "POST" or event.get("rawPath") != "/gmail/push":
        return _resp(404, {"error": "not found"})
    token = (event.get("queryStringParameters") or {}).get("token")
    if not push_authorized(settings, token):
        return _resp(403, {"error": "bad push token"})
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode()
    log.info("gmail push: %s", describe_push(json.loads(raw)))
    try:
        report = run(settings, store)
    except ProviderError as exc:
        log.warning("push run failed: %s", exc)
        return _resp(502, {"error": str(exc)})  # Pub/Sub will redeliver
    log.info("push run: %s", json.dumps(report))
    return _resp(200, report)


def _resp(status: int, body: dict[str, Any]) -> dict[str, Any]:
    return {"statusCode": status, "headers": {"content-type": "application/json"}, "body": json.dumps(body)}
