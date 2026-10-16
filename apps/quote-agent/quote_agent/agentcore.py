"""Amazon Bedrock AgentCore Runtime entry point (HTTP protocol).

AgentCore Runtime runs this image as a container in a per-session microVM and
talks to it over its service contract, which the official `bedrock-agentcore`
SDK implements:

    0.0.0.0:8080   POST /invocations   JSON payload in, JSON out
                   GET  /ping          {"status": "Healthy" | "HealthyBusy", ...}

The caller (an InvokeAgentRuntime client: a Lambda behind the Slack/Gmail
webhooks, a CRM automation, an external control plane) is authenticated by
AgentCore itself, with IAM SigV4 or the runtime's JWT authorizer, before the
payload reaches this process. The payload names an action:

    {"action": "quote.message",  "message": {InboundMessage}}
    {"action": "quote.decide",   "approval_id": "APR-...", "decision": "approved", "decided_by": "U..."}
    {"action": "handoff.start",  "quote_id": "Q-...", "requested_by": "..."}
    {"action": "handoff.get",    "run_id": "HND-..."}
    {"action": "research.brief", "customer_email": "..."}
    {"action": "agents.list"}

Operator actions change the controls, so they are off unless
AGENTCORE_OPERATOR_ACTIONS=true. Deploy the same image a second time as an
operator runtime, with that flag on and an IAM invoke policy only operators
hold. That keeps "start work" and "change the controls" apart, as the two
HTTP tokens do in the ECS deployment:

    {"action": "agents.contain" | "agents.release", "agent": "billing", "by": "..."}
    {"action": "handoff.pause" | "handoff.resume" | "handoff.retry" | "handoff.verify", "run_id": "HND-...", "by": "..."}
    {"action": "actions.export", "run_id": "HND-..." (optional)}

Each session gets its own microVM with its own filesystem, so SQLite would not
be shared between sessions. Outside development this role refuses to start
without PostgreSQL (config.validate). Handoff steps run inside the invocation
(QUEUE_BACKEND=inline). With QUEUE_BACKEND=sqs they are queued for the ECS
workers instead.
"""

import json
import logging
import os
from typing import Any

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from starlette.responses import JSONResponse

from .handoff.gateway import ActionBlocked
from .handoff.workflow import HandoffError
from .models import InboundMessage
from .orchestrator import Orchestrator

log = logging.getLogger(__name__)

AGENT_ACTIONS = {"quote.message", "quote.decide", "handoff.start", "handoff.get", "research.brief", "agents.list"}
OPERATOR_ACTIONS = {"agents.contain", "agents.release", "handoff.pause", "handoff.resume", "handoff.retry",
                    "handoff.verify", "actions.export"}


def load_secrets_from_aws(env: dict[str, str] | None = None, client: Any = None) -> list[str]:
    """Fill missing env vars from the JSON secret named by APP_SECRET_ARN.

    AgentCore runtime environment variables are plain configuration, so
    provider credentials stay in Secrets Manager. The runtime's execution role
    reads them once at start-up. Variables already set win. Returns the names
    loaded, never the values.
    """
    env = os.environ if env is None else env
    arns = [a for a in (env.get("APP_SECRET_ARN", ""), env.get("DB_SECRET_ARN", "")) if a]
    if not arns:
        return []
    if client is None:
        import boto3
        client = boto3.client("secretsmanager", region_name=env.get("AWS_REGION") or None)
    loaded = []
    for arn in arns:
        values = json.loads(client.get_secret_value(SecretId=arn)["SecretString"])
        if arn == env.get("DB_SECRET_ARN"):  # the RDS-managed secret holds username/password
            values = {"DB_USER": values.get("username", ""), "DB_PASSWORD": values.get("password", "")}
        for key, value in values.items():
            if value and not env.get(key):
                env[key] = str(value)
                loaded.append(key)
    return sorted(loaded)


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


def build_agentcore_app(orch: Orchestrator, *, operator_actions: bool = False) -> BedrockAgentCoreApp:
    app = BedrockAgentCoreApp()

    @app.entrypoint
    def invoke(payload: dict, context) -> Any:
        """One AgentCore invocation. Sync on purpose: the SDK runs it in a thread so /ping stays responsive."""
        if not isinstance(payload, dict) or not isinstance(payload.get("action"), str):
            return _error(400, 'payload must be a JSON object with an "action"')
        action = payload["action"]
        if action in OPERATOR_ACTIONS and not operator_actions:
            return _error(403, f"{action} is an operator action; this runtime does not accept operator actions")
        if action not in AGENT_ACTIONS | OPERATOR_ACTIONS:
            return _error(400, f"unknown action {action!r}")
        session = getattr(context, "session_id", None)
        log.info("agentcore invocation %s (session %s)", action, session)
        try:
            return _dispatch(orch, action, payload)
        except HandoffError as exc:
            return _error(exc.status, str(exc))
        except ActionBlocked as exc:
            return _error(403, str(exc))
        except (KeyError, ValueError) as exc:
            return _error(400, f"bad payload for {action}: {exc}")

    return app


def _dispatch(orch: Orchestrator, action: str, p: dict) -> Any:
    h = orch.handoff
    if action == "quote.message":
        run = orch.handle_inbound(InboundMessage.model_validate(p["message"]))
        return run or {"duplicate": True}
    if action == "quote.decide":
        return orch.resume_approval(p["approval_id"], p["decision"], p.get("decided_by", "agentcore")) \
            or {"already_decided": True}
    if h is None:
        return _error(503, "handoff is not configured")
    by = p.get("by") or p.get("requested_by") or "agentcore"
    if action == "handoff.start":
        run, created = h.start(p["quote_id"], by)
        return {**run, "created": created}
    if action == "handoff.get":
        run = h.handoffs.get_run(p["run_id"])
        return run or _error(404, "handoff run not found")
    if action == "research.brief":
        if orch.research is None:
            return _error(503, "research agent not configured")
        return orch.research.brief(p["customer_email"], by)
    if action == "agents.list":
        return {"agents": h.gateway.manifests()}
    if action in {"agents.contain", "agents.release"}:
        if p.get("agent") not in {m["name"] for m in h.gateway.manifests()}:
            return _error(404, f"unknown agent {p.get('agent')!r}")
        return h.contain(p["agent"], by) if action == "agents.contain" else h.release(p["agent"], by)
    if action == "actions.export":
        return {"actions": h.handoffs.list_actions(p.get("run_id"), int(p.get("limit", 500)))}
    verb = action.split(".", 1)[1]  # handoff.pause|resume|retry|verify
    return getattr(h, verb)(p["run_id"], by)
