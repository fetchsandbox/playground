# syntax=docker/dockerfile:1.7
# One image, several roles: `api` (default), `worker`, `agentcore`, `migrate`, `gmail-watch`, `reap-stale-runs`.
#
# Amazon Bedrock AgentCore Runtime needs an ARM64 image listening on 0.0.0.0:8080
# and starting the AgentCore server by default (its runtime config has no command):
#   docker buildx build --platform linux/arm64 --target agentcore -t <ecr>/quote-agent:agentcore-<sha> .
# The base image and every dependency wheel (psycopg-binary included) exist for linux/arm64.

FROM python:3.12-slim-bookworm AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
COPY requirements.txt /tmp/requirements.txt
# Behind a TLS-inspecting proxy, pass its CA without baking it into a layer:
#   docker build --secret id=ca_bundle,src=/path/to/ca.pem .
RUN --mount=type=secret,id=ca_bundle,required=false \
    if [ -f /run/secrets/ca_bundle ]; then export PIP_CERT=/run/secrets/ca_bundle; fi; \
    /opt/venv/bin/pip install -r /tmp/requirements.txt

FROM python:3.12-slim-bookworm AS app
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8000
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --no-create-home app
COPY --from=build /opt/venv /opt/venv
WORKDIR /app
COPY quote_agent ./quote_agent
USER 10001:10001
EXPOSE 8000
# Health checks are defined per role by the orchestrator (ALB -> /health for the api).
ENTRYPOINT ["python", "-m", "quote_agent"]
CMD ["api"]

# AgentCore Runtime target: same image, AgentCore server on 8080 by default.
FROM app AS agentcore
EXPOSE 8080
CMD ["agentcore"]

# Default target (ECS api/worker/jobs): unchanged.
FROM app
