"""Amazon Bedrock AgentCore Runtime compatibility.

The official bedrock-agentcore SDK app is served in-process: these are the
same /invocations and /ping handlers AgentCore Runtime calls in the microVM.
"""

import importlib.util
import json
import re
from pathlib import Path

import pytest
from botocore.stub import Stubber
from fastapi.testclient import TestClient
from test_workflow import CUSTOMER, email, send_initial_quote

from quote_agent.agentcore import build_agentcore_app, load_secrets_from_aws
from quote_agent.config import ConfigError, Settings

APP_DIR = Path(__file__).resolve().parents[1]
SESSION = {"X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": "sess-" + "a" * 33}


def _deploy_module():
    spec = importlib.util.spec_from_file_location("agentcore_deploy", APP_DIR / "infra/agentcore/deploy.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def runtime(orch):
    return TestClient(build_agentcore_app(orch))


@pytest.fixture
def operator_runtime(orch):
    return TestClient(build_agentcore_app(orch, operator_actions=True))


def invoke(client, payload, headers=SESSION):
    return client.post("/invocations", json=payload, headers=headers)


# ------------------------------------------------------------- service contract


def test_ping_reports_healthy(runtime):
    r = runtime.get("/ping")
    assert r.status_code == 200 and r.json()["status"] == "Healthy"
    assert isinstance(r.json()["time_of_last_update"], int)


def test_invalid_json_is_a_400(runtime):
    r = runtime.post("/invocations", content=b"{not json", headers={**SESSION, "Content-Type": "application/json"})
    assert r.status_code == 400


@pytest.mark.parametrize("payload,status", [({}, 400), ({"action": "nope"}, 400), ({"action": "handoff.start"}, 400),
                                            (["not", "an", "object"], 400)])
def test_bad_payloads_are_rejected(runtime, payload, status):
    assert invoke(runtime, payload).status_code == status


# ------------------------------------------------------------- the workflows


def test_quote_then_handoff_through_invocations(runtime, orch, fake):
    msg = email("m-ac", "Hi, could you send a quote for 25 seats of Pro? Thanks, Dana").model_dump()
    quote_run = invoke(runtime, {"action": "quote.message", "message": msg}).json()
    assert quote_run["status"] == "completed"

    run = invoke(runtime, {"action": "handoff.start", "quote_id": quote_run["quote_id"], "requested_by": "crm"}).json()
    assert run["status"] == "completed" and run["created"] is True
    assert [s["status"] for s in run["steps"]] == ["verified", "verified", "verified"]
    assert len(fake.invoices_for(CUSTOMER)) == 1 and len(fake.resend_emails) == 1

    again = invoke(runtime, {"action": "handoff.start", "quote_id": quote_run["quote_id"]}).json()
    assert again["created"] is False and again["id"] == run["id"] and len(fake.resend_emails) == 1
    got = invoke(runtime, {"action": "handoff.get", "run_id": run["id"]}).json()
    assert got["id"] == run["id"]


def test_discount_approval_through_invocations(runtime, orch, fake):
    send_initial_quote(orch, fake)
    paused = invoke(runtime, {"action": "quote.message",
                              "message": email("m-d", "Can you do 25% off?").model_dump()}).json()
    assert paused["status"] == "awaiting_approval"
    # Not handed off while waiting on the manager: a 409, the same rule as the HTTP API.
    assert invoke(runtime, {"action": "handoff.start", "quote_id": paused["quote_id"]}).status_code == 409
    done = invoke(runtime, {"action": "quote.decide", "approval_id": paused["approval_id"], "decision": "approved",
                            "decided_by": "U_MANAGER"}).json()
    assert done["status"] == "completed"
    run = invoke(runtime, {"action": "handoff.start", "quote_id": paused["quote_id"]}).json()
    assert run["status"] == "completed" and run["amount_cents"] == 1_125_000


def test_research_and_agent_discovery(runtime, orch, fake):
    send_initial_quote(orch, fake)
    brief = invoke(runtime, {"action": "research.brief", "customer_email": CUSTOMER}).json()
    assert "email" not in brief["facts"]["contact"] and brief["facts"]["quotes"]
    agents = {a["name"] for a in invoke(runtime, {"action": "agents.list"}).json()["agents"]}
    assert agents == {"quote", "research", "crm", "billing", "messaging"}


# ------------------------------------------------------------- operator split


@pytest.mark.parametrize("payload", [{"action": "agents.contain", "agent": "billing"},
                                     {"action": "handoff.retry", "run_id": "HND-X"},
                                     {"action": "actions.export"}])
def test_agent_runtime_refuses_operator_actions(runtime, orch, payload):
    r = invoke(runtime, payload)
    assert r.status_code == 403 and "operator action" in r.json()["error"]
    assert not orch.handoff.gateway.is_contained("billing")


def test_operator_runtime_contains_pauses_and_retries(operator_runtime, orch, fake):
    quote = send_initial_quote(orch, fake)
    assert invoke(operator_runtime, {"action": "agents.contain", "agent": "billing", "by": "secops"}).json()["contained"]
    run = invoke(operator_runtime, {"action": "handoff.start", "quote_id": quote.id}).json()
    assert run["status"] == "blocked" and fake.stripe_requests == []
    invoke(operator_runtime, {"action": "agents.release", "agent": "billing"})
    run = invoke(operator_runtime, {"action": "handoff.retry", "run_id": run["id"], "by": "secops"}).json()
    assert run["status"] == "completed"
    log = invoke(operator_runtime, {"action": "actions.export", "run_id": run["id"]}).json()["actions"]
    assert ("billing_invoice", "blocked") in [(a["step"], a["outcome"]) for a in log]
    assert invoke(operator_runtime, {"action": "agents.contain", "agent": "nobody"}).status_code == 404


# ------------------------------------------------------------- start-up


class FakeSecrets:
    def __init__(self, secrets):
        self.secrets = secrets

    def get_secret_value(self, SecretId):
        return {"SecretString": json.dumps(self.secrets[SecretId])}


def test_credentials_load_from_secrets_manager_without_overriding():
    env = {"APP_SECRET_ARN": "arn:app", "DB_SECRET_ARN": "arn:db", "STRIPE_SECRET_KEY": "already-set"}
    loaded = load_secrets_from_aws(env, FakeSecrets({
        "arn:app": {"STRIPE_SECRET_KEY": "from-secret", "RESEND_API_KEY": "re_x", "GMAIL_CLIENT_ID": ""},
        "arn:db": {"username": "qa", "password": "pw"}}))
    assert loaded == ["DB_PASSWORD", "DB_USER", "RESEND_API_KEY"]  # names only, never values
    assert env["STRIPE_SECRET_KEY"] == "already-set" and env["DB_USER"] == "qa" and "GMAIL_CLIENT_ID" not in env


def test_no_secret_arn_loads_nothing():
    assert load_secrets_from_aws({}, client=None) == []


def test_agentcore_role_needs_postgres_but_not_sqs():
    s = Settings(environment="staging", database_url="postgresql://x/y", queue_backend="inline")
    s.validate("agentcore")
    with pytest.raises(ConfigError, match="QUEUE_BACKEND=sqs"):
        s.validate("api")
    with pytest.raises(ConfigError, match="PostgreSQL"):
        Settings(environment="staging", queue_backend="inline").validate("agentcore")


def test_agentcore_command_serves_on_8080(monkeypatch, tmp_path):
    from bedrock_agentcore.runtime import BedrockAgentCoreApp

    from quote_agent.__main__ import main
    served = {}
    monkeypatch.setattr(BedrockAgentCoreApp, "run", lambda self, port, host=None, **kw: served.update(port=port, host=host))
    monkeypatch.setenv("QUOTE_AGENT_DB", str(tmp_path / "ac.db"))
    monkeypatch.setenv("CLASSIFIER", "rules")
    assert main(["agentcore"]) == 0
    assert served == {"port": 8080, "host": "0.0.0.0"}


# ------------------------------------------------------------- image + deploy


def test_dockerfile_has_an_agentcore_target_and_keeps_the_default():
    text = (APP_DIR / "Dockerfile").read_text()
    stages = re.findall(r"^FROM\s+(\S+)(?:\s+AS\s+(\S+))?", text, re.M)
    assert ("app", "agentcore") in stages
    assert stages[-1] == ("app", "")  # the default target is still the ECS image
    agentcore = text.split("FROM app AS agentcore", 1)[1].split("FROM app", 1)[0]
    assert 'CMD ["agentcore"]' in agentcore and "EXPOSE 8080" in agentcore
    assert "linux/arm64" in text


OUTPUTS = {"role_arn": "arn:aws:iam::123456789012:role/quote-agent-staging-agentcore",
           "security_group_ids": ["sg-0123456789abcdef0"], "subnet_ids": ["subnet-0aaa1111", "subnet-0bbb2222"],
           "ecr_repository_url": "123456789012.dkr.ecr.us-east-1.amazonaws.com/quote-agent-staging",
           "app_secret_arn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:quote-agent-staging/app-AbCdEf",
           "db_secret_arn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!db-123-XyZ",
           "db_host": "db.example.internal", "db_port": "5432", "db_name": "quote_agent",
           "jobs_queue_url": "https://sqs.us-east-1.amazonaws.com/123456789012/quote-agent-staging-jobs",
           "region": "us-east-1", "environment": "staging"}


@pytest.mark.parametrize("kw", [{}, {"operator": True}, {"queue": "sqs"},
                                {"jwt_discovery_url": "https://idp.example.com/.well-known/openid-configuration",
                                 "jwt_allowed_clients": ["looplabs"]}])
def test_deploy_request_matches_the_agentcore_api_model(kw):
    deploy = _deploy_module()
    req = deploy.build_request(OUTPUTS, "abc123", **kw)
    deploy.validate("CreateAgentRuntime", req)  # botocore's bedrock-agentcore-control model
    assert req["networkConfiguration"]["networkMode"] == "VPC"
    assert req["protocolConfiguration"] == {"serverProtocol": "HTTP"}
    assert req["agentRuntimeArtifact"]["containerConfiguration"]["containerUri"].endswith(":agentcore-abc123")
    env = req["environmentVariables"]
    assert len(env) <= 50 and "STRIPE_SECRET_KEY" not in env  # secrets stay in Secrets Manager
    assert (env.get("AGENTCORE_OPERATOR_ACTIONS") == "true") == bool(kw.get("operator"))
    assert req["agentRuntimeName"] == "quote_agent_staging" + ("_operator" if kw.get("operator") else "")


def test_deploy_creates_then_updates():
    import boto3
    deploy = _deploy_module()
    client = boto3.client("bedrock-agentcore-control", region_name="us-east-1",
                          aws_access_key_id="x", aws_secret_access_key="x")
    req = deploy.build_request(OUTPUTS, "abc123")
    with Stubber(client) as stub:
        stub.add_response("list_agent_runtimes", {"agentRuntimes": []})
        stub.add_response("create_agent_runtime", {
            "agentRuntimeArn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/quote_agent_staging-AbC123dEfG",
            "agentRuntimeId": "quote_agent_staging-AbC123dEfG", "agentRuntimeVersion": "1", "status": "CREATING",
            "createdAt": "2026-10-16T00:00:00Z"}, req)
        assert deploy.deploy(req, client)["status"] == "CREATING"
    update = {k: v for k, v in req.items() if k != "agentRuntimeName"} | {"agentRuntimeId": "quote_agent_staging-AbC123dEfG"}
    with Stubber(client) as stub:
        stub.add_response("list_agent_runtimes", {"agentRuntimes": [{
            "agentRuntimeArn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/quote_agent_staging-AbC123dEfG",
            "agentRuntimeId": "quote_agent_staging-AbC123dEfG", "agentRuntimeName": "quote_agent_staging",
            "agentRuntimeVersion": "1", "description": "Quote agent", "lastUpdatedAt": "2026-10-16T00:00:00Z", "status": "READY"}]})
        stub.add_response("update_agent_runtime", {
            "agentRuntimeArn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/quote_agent_staging-AbC123dEfG",
            "agentRuntimeId": "quote_agent_staging-AbC123dEfG", "agentRuntimeVersion": "2", "status": "UPDATING",
            "createdAt": "2026-10-16T00:00:00Z", "lastUpdatedAt": "2026-10-16T00:00:00Z"}, update)
        assert deploy.deploy(req, client)["agentRuntimeVersion"] == "2"


@pytest.mark.parametrize("breaks", [
    lambda r: r["protocolConfiguration"].update(serverProtocol="GRPC"),              # enum
    lambda r: r["networkConfiguration"].update(networkMode="PRIVATE"),               # enum
    lambda r: r.update(agentRuntimeName="quote-agent-staging"),                      # pattern: no hyphens
    lambda r: r["agentRuntimeArtifact"]["containerConfiguration"].update(containerUri="docker.io/quote:1"),  # ECR only
    lambda r: r["lifecycleConfiguration"].update(idleRuntimeSessionTimeout=10),     # range
    lambda r: r.pop("roleArn"),                                                      # required
])
def test_deploy_rejects_an_invalid_request(breaks):
    deploy = _deploy_module()
    req = deploy.build_request(OUTPUTS, "abc123")
    breaks(req)
    with pytest.raises(SystemExit, match="invalid"):
        deploy.validate("CreateAgentRuntime", req)
