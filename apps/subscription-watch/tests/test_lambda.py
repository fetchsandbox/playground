"""The Lambda handler, with DynamoDB (moto) and Secrets Manager (moto)."""

import base64
import importlib
import json

import boto3
import httpx
import pytest
from moto import mock_aws

from tests.fakes import FakeProviders, raw_email

NETFLIX = raw_email("Netflix <info@account.netflix.com>", "Your Netflix subscription payment receipt",
                    "Your monthly subscription of $15.49 was charged. Next billing date: November 13, 2026.")


@pytest.fixture
def lam(monkeypatch):
    with mock_aws():
        monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
        ddb = boto3.client("dynamodb")
        ddb.create_table(TableName="processed", BillingMode="PAY_PER_REQUEST",
                         AttributeDefinitions=[{"AttributeName": "message_id", "AttributeType": "S"}],
                         KeySchema=[{"AttributeName": "message_id", "KeyType": "HASH"}])
        arn = boto3.client("secretsmanager").create_secret(Name="subwatch", SecretString=json.dumps({
            "GOOGLE_ACCESS_TOKEN": "g", "SLACK_BOT_TOKEN": "xoxb-test", "PUSH_TOKEN": "s3cret",
        }))["ARN"]
        for k, v in {
            "SECRETS_ARN": arn, "STATE_BACKEND": "dynamodb", "DYNAMODB_TABLE": "processed",
            "SLACK_CHANNEL": "C0BILLING01", "GMAIL_BASE_URL": "https://gmail.test",
            "CALENDAR_BASE_URL": "https://calendar.test", "SLACK_BASE_URL": "https://slack.test",
        }.items():
            monkeypatch.setenv(k, v)
        for k in ("GOOGLE_ACCESS_TOKEN", "SLACK_BOT_TOKEN", "PUSH_TOKEN"):
            monkeypatch.delenv(k, raising=False)

        fake = FakeProviders()
        fake.add("m-netflix", NETFLIX)
        real_client = httpx.Client
        monkeypatch.setattr(httpx, "Client", lambda **kw: real_client(**{**kw, "transport": fake.transport()}))

        import lambda_handler
        importlib.reload(lambda_handler)
        yield lambda_handler, fake, ddb


def push_event(token, path="/gmail/push", body=None, headers=None):
    data = base64.b64encode(json.dumps({"emailAddress": "me@example.test", "historyId": "42"}).encode()).decode()
    return {
        "rawPath": path, "requestContext": {"http": {"method": "POST"}},
        "queryStringParameters": {"token": token} if token else None,
        "headers": headers or {},
        "body": body if body is not None else json.dumps({"message": {"data": data, "messageId": "1"}, "subscription": "s"}),
        "isBase64Encoded": False,
    }


def test_scheduled_run_persists_to_dynamodb(lam):
    handler, fake, ddb = lam
    report = handler.handler({"source": "aws.events"}, None)
    assert report["completed"] == ["m-netflix"]
    item = ddb.get_item(TableName="processed", Key={"message_id": {"S": "m-netflix"}})["Item"]
    assert item["status"]["S"] == "completed"
    # second sweep: nothing new
    assert handler.handler({"source": "aws.events"}, None)["already_done"] == 1
    assert len(fake.slack_posts) == 1 and len(fake.events) == 1


def test_push_requires_token(lam):
    handler, fake, _ = lam
    assert handler.handler(push_event("wrong"), None)["statusCode"] == 403
    assert handler.handler(push_event(None), None)["statusCode"] == 403
    assert fake.slack_posts == []
    resp = handler.handler(push_event("s3cret"), None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])["completed"] == ["m-netflix"]


def test_unknown_route_404(lam):
    handler, _, _ = lam
    assert handler.handler(push_event("s3cret", path="/other"), None)["statusCode"] == 404


def test_push_token_in_path_or_bearer_header(lam):
    handler, fake, _ = lam
    assert handler.handler(push_event(None, path="/gmail/push/wrong"), None)["statusCode"] == 403
    # a path token is authoritative: a valid header does not rescue a wrong path token
    assert handler.handler(push_event(None, path="/gmail/push/wrong",
                                      headers={"Authorization": "Bearer s3cret"}), None)["statusCode"] == 403
    assert fake.slack_posts == []
    assert handler.handler(push_event(None, headers={"Authorization": "Bearer s3cret"}), None)["statusCode"] == 200
    assert handler.handler(push_event(None, path="/gmail/push/s3cret"), None)["statusCode"] == 200
    assert len(fake.slack_posts) == 1


@pytest.mark.parametrize("body", ["not json", "[]", '{"message": "x"}', '{"message": {"data": "!!"}}', ""])
def test_malformed_push_is_acknowledged_and_still_sweeps(lam, body):
    handler, fake, _ = lam
    resp = handler.handler(push_event("s3cret", body=body), None)
    assert resp["statusCode"] == 200  # a 4xx/5xx would make Pub/Sub redeliver garbage forever
    assert json.loads(resp["body"])["completed"] == ["m-netflix"]
