"""Create or update the quote agent's Amazon Bedrock AgentCore Runtime.

    terraform -chdir=infra/terraform output -json agentcore > agentcore.json
    python infra/agentcore/deploy.py --outputs agentcore.json --image-tag <git-sha> [--operator] [--dry-run]

It deploys the `agentcore` image target (linux/arm64), pushed to the stack's
ECR repository as `<repo>:agentcore-<sha>`. The runtime runs in VPC mode on
the private subnets, so it reaches RDS and the VPC endpoints. It uses the HTTP
server protocol (port 8080, /invocations, /ping). Credentials stay in Secrets
Manager: the runtime only gets the secret ARNs, and the execution role reads
them at start-up (quote_agent/agentcore.py).

Two runtimes from one image:
  - `quote_agent_<env>`: agent actions (quotes, handoff start/read, research).
    Grant InvokeAgentRuntime on it to the callers that start work.
  - `quote_agent_<env>_operator` (--operator): also accepts contain, pause,
    retry, verify and export (AGENTCORE_OPERATOR_ACTIONS=true). Grant invoke
    on it to operators only.

--dry-run builds the request and checks it against the bedrock-agentcore-control
API model shipped with botocore, without calling AWS.
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

import botocore.session
from botocore.validate import ParamValidator

SERVICE = "bedrock-agentcore-control"


def runtime_name(environment: str, operator: bool) -> str:
    name = f"quote_agent_{environment}" + ("_operator" if operator else "")
    if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_]{0,47}", name):
        raise SystemExit(f"invalid runtime name {name!r}")
    return name


def build_request(out: dict[str, Any], image_tag: str, *, operator: bool = False, queue: str = "inline",
                  extra_env: dict[str, str] | None = None, jwt_discovery_url: str | None = None,
                  jwt_allowed_clients: list[str] | None = None, idle_timeout: int = 900,
                  max_lifetime: int = 28800) -> dict[str, Any]:
    env = {
        "ENVIRONMENT": out["environment"],
        "LOG_FORMAT": "json",
        "AWS_REGION": out["region"],
        # No init container in AgentCore: migrate on start (advisory-locked, so concurrent microVMs are safe).
        "AUTO_MIGRATE": "true",
        "QUEUE_BACKEND": queue,
        "DB_HOST": out["db_host"],
        "DB_PORT": out["db_port"],
        "DB_NAME": out["db_name"],
        "DB_SSLMODE": "require",
        "APP_SECRET_ARN": out["app_secret_arn"],
        "DB_SECRET_ARN": out["db_secret_arn"],
    }
    if queue == "sqs":
        env["SQS_QUEUE_URL"] = out["jobs_queue_url"]
    if operator:
        env["AGENTCORE_OPERATOR_ACTIONS"] = "true"
    env.update(extra_env or {})
    request: dict[str, Any] = {
        "agentRuntimeName": runtime_name(out["environment"], operator),
        "description": "Quote agent + customer handoff agents" + (" (operator actions)" if operator else ""),
        "agentRuntimeArtifact": {"containerConfiguration": {
            "containerUri": f"{out['ecr_repository_url']}:agentcore-{image_tag}"}},
        "roleArn": out["role_arn"],
        "networkConfiguration": {"networkMode": "VPC", "networkModeConfig": {
            "subnets": out["subnet_ids"], "securityGroups": out["security_group_ids"]}},
        "protocolConfiguration": {"serverProtocol": "HTTP"},
        "lifecycleConfiguration": {"idleRuntimeSessionTimeout": idle_timeout, "maxLifetime": max_lifetime},
        "environmentVariables": env,
    }
    if jwt_discovery_url:  # otherwise callers authenticate with IAM SigV4
        request["authorizerConfiguration"] = {"customJWTAuthorizer": {
            "discoveryUrl": jwt_discovery_url, "allowedClients": jwt_allowed_clients or []}}
    return request


def _model_checks(value: Any, shape: Any, path: str, errors: list[str]) -> None:
    """Enums and patterns from the model, which botocore's ParamValidator does not check."""
    if shape.type_name == "structure" and isinstance(value, dict):
        for k, v in value.items():
            if k in shape.members:
                _model_checks(v, shape.members[k], f"{path}.{k}", errors)
    elif shape.type_name == "list" and isinstance(value, list):
        for i, v in enumerate(value):
            _model_checks(v, shape.member, f"{path}[{i}]", errors)
    elif shape.type_name == "map" and isinstance(value, dict):
        for k, v in value.items():
            _model_checks(k, shape.key, f"{path} key {k!r}", errors)
            _model_checks(v, shape.value, f"{path}.{k}", errors)
    elif shape.type_name == "string" and isinstance(value, str):
        if shape.enum and value not in shape.enum:
            errors.append(f"{path}: {value!r} is not one of {shape.enum}")
        pattern = shape.metadata.get("pattern")
        if pattern and not re.fullmatch(pattern, value):
            errors.append(f"{path}: {value!r} does not match {pattern}")


def validate(operation: str, params: dict[str, Any]) -> None:
    """Check params against the AWS API model: botocore's validator (required fields, types, lengths,
    ranges) plus the model's enums and patterns."""
    model = botocore.session.get_session().get_service_model(SERVICE).operation_model(operation)
    report = ParamValidator().validate(params, model.input_shape)
    errors = [report.generate_report()] if report.has_errors() else []
    _model_checks(params, model.input_shape, operation, errors)
    if errors:
        raise SystemExit(f"{operation} request is invalid:\n" + "\n".join(errors))


def find_runtime(client: Any, name: str) -> dict[str, Any] | None:
    token = None
    while True:
        page = client.list_agent_runtimes(**({"nextToken": token} if token else {}))
        for rt in page.get("agentRuntimes", []):
            if rt["agentRuntimeName"] == name:
                return rt
        token = page.get("nextToken")
        if not token:
            return None


def deploy(request: dict[str, Any], client: Any) -> dict[str, Any]:
    existing = find_runtime(client, request["agentRuntimeName"])
    if existing is None:
        validate("CreateAgentRuntime", request)
        return client.create_agent_runtime(**request)
    update = {k: v for k, v in request.items() if k != "agentRuntimeName"}
    update["agentRuntimeId"] = existing["agentRuntimeId"]
    validate("UpdateAgentRuntime", update)
    return client.update_agent_runtime(**update)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--outputs", required=True, help="`terraform output -json agentcore` saved to a file")
    p.add_argument("--image-tag", required=True, help="git SHA; the image is <repo>:agentcore-<sha>")
    p.add_argument("--operator", action="store_true", help="deploy the operator runtime")
    p.add_argument("--queue", choices=["inline", "sqs"], default="inline",
                   help="inline: handoff steps run in the invocation; sqs: queued for the ECS workers")
    p.add_argument("--env", action="append", default=[], metavar="KEY=VALUE", help="extra non-secret setting")
    p.add_argument("--jwt-discovery-url", help="use a JWT authorizer instead of IAM SigV4")
    p.add_argument("--jwt-allowed-client", action="append", default=[])
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)

    out = json.loads(Path(a.outputs).read_text())
    if out is None:
        raise SystemExit("terraform output `agentcore` is null: set agentcore_enabled = true and apply")
    extra = dict(kv.split("=", 1) for kv in a.env)
    request = build_request(out, a.image_tag, operator=a.operator, queue=a.queue, extra_env=extra,
                            jwt_discovery_url=a.jwt_discovery_url, jwt_allowed_clients=a.jwt_allowed_client)
    if a.dry_run:
        validate("CreateAgentRuntime", request)
        print(json.dumps(request, indent=2))
        return 0
    import boto3
    result = deploy(request, boto3.client(SERVICE, region_name=out["region"]))
    print(json.dumps({k: result.get(k) for k in ("agentRuntimeArn", "agentRuntimeId", "agentRuntimeVersion",
                                                  "status")}, default=str, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
