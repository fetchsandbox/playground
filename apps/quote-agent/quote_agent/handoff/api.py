"""HTTP surface for the handoff, research and agent control.

Two credentials, so whoever starts work cannot also change the controls:
  * HANDOFF_API_TOKEN: start a handoff, read runs and manifests, request a
    research brief. This is what an external agent or a CRM "deal won"
    automation holds: POST /handoff/runs {"quote_id": "Q-..."}.
  * QUOTE_AGENT_ADMIN_TOKEN (operators): contain/release agents, pause,
    resume, retry and verify runs, and export the action log.
With a token unset its routes are disabled (404), unless DEV_ENDPOINTS is on.

    GET  /agents                          agent manifests: owner, allowed actions, systems, contained
    POST /handoff/runs                    start (or return the existing) handoff for a sent quote
    GET  /handoff/runs[/{id}]             runs with their steps
    POST /research/briefs                 read-only account brief
  operator:
    POST /agents/{agent}/contain|release  the stop button, per agent
    POST /handoff/runs/{id}/pause|resume|retry|verify
    GET  /actions[?run_id=]               the append-only action log (export)
"""

import secrets

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

from ..config import Settings
from .gateway import ActionBlocked
from .research import ResearchAgent
from .workflow import HandoffError, HandoffWorkflow


class StartHandoff(BaseModel):
    quote_id: str
    requested_by: str = "api"


class Brief(BaseModel):
    customer_email: str
    requested_by: str = "api"


def build_router(s: Settings, workflow: HandoffWorkflow, research: ResearchAgent | None) -> APIRouter:
    def _check(token: str, setting: str, authorization: str | None) -> None:
        if not token:
            if s.dev_endpoints:
                return
            raise HTTPException(404, f"disabled (set {setting})")
        if not authorization or not secrets.compare_digest(authorization, f"Bearer {token}"):
            raise HTTPException(401, f"{setting} required")

    def _auth(authorization: str | None = Header(None)) -> None:
        _check(s.handoff_api_token, "HANDOFF_API_TOKEN", authorization)

    def _operator(authorization: str | None = Header(None)) -> None:
        _check(s.admin_token, "QUOTE_AGENT_ADMIN_TOKEN", authorization)

    router = APIRouter(tags=["handoff"])
    agent_route = {"dependencies": [Depends(_auth)]}
    operator_route = {"dependencies": [Depends(_operator)]}

    def _call(fn, *args):
        try:
            return fn(*args)
        except HandoffError as exc:
            raise HTTPException(exc.status, str(exc)) from exc

    @router.get("/agents", **agent_route)
    def agents():
        return {"agents": workflow.gateway.manifests()}

    @router.post("/agents/{agent}/contain", **operator_route)
    def contain(agent: str, by: str = "api"):
        if agent not in {m["name"] for m in workflow.gateway.manifests()}:
            raise HTTPException(404, f"unknown agent {agent}")
        return workflow.contain(agent, by)

    @router.post("/agents/{agent}/release", **operator_route)
    def release(agent: str, by: str = "api"):
        if agent not in {m["name"] for m in workflow.gateway.manifests()}:
            raise HTTPException(404, f"unknown agent {agent}")
        return workflow.release(agent, by)

    @router.post("/handoff/runs", **agent_route)
    def start(body: StartHandoff):
        run, created = _call(workflow.start, body.quote_id, body.requested_by)
        return {**run, "created": created}

    @router.get("/handoff/runs", **agent_route)
    def list_runs(limit: int = 50):
        return {"runs": workflow.handoffs.list_runs(limit)}

    @router.get("/handoff/runs/{run_id}", **agent_route)
    def get_run(run_id: str):
        run = workflow.handoffs.get_run(run_id)
        if not run:
            raise HTTPException(404, "handoff run not found")
        return run

    for name in ("pause", "resume", "retry", "verify"):
        def _route(run_id: str, by: str = "api", _name: str = name):
            return _call(getattr(workflow, _name), run_id, by)
        router.add_api_route(f"/handoff/runs/{{run_id}}/{name}", _route, methods=["POST"], name=f"handoff_{name}",
                             **operator_route)

    @router.get("/actions", **operator_route)
    def actions(run_id: str | None = None, limit: int = 500):
        return {"actions": workflow.handoffs.list_actions(run_id, limit)}

    @router.post("/research/briefs", **agent_route)
    def brief(body: Brief):
        if research is None:
            raise HTTPException(503, "research agent not configured")
        try:
            return research.brief(body.customer_email, body.requested_by)
        except ActionBlocked as exc:
            raise HTTPException(403, str(exc)) from exc

    return router
