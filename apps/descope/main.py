"""Acme Agent Gateway — Descope agentic (access-key) auth backend.

AI agents authenticate with a Descope *access key*, exchange it for a scoped
session JWT, then call operations gated by those scopes.

Surface:
  POST /api/agent/exchange     exchange a Descope access key for a scoped session
  GET  /api/agent/whoami       return the agent identity + granted scopes
  POST /api/tenant/users       create a user (requires the users:write scope)
"""
from __future__ import annotations

import os

import jwt
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI(title="Acme Agent Gateway")

DESCOPE_PROJECT_ID = os.environ.get("DESCOPE_PROJECT_ID", "")
# HS256 session secret for the exchanged token. Real deploys verify Descope's
# session JWTs against its JWKS; kept simple here so the app runs with no keys.
SESSION_SECRET = os.environ.get("SESSION_SECRET", "dev-only-not-for-prod")

# The access keys Descope issued to our agents, with the scopes each was
# GRANTED. In prod this lives in Descope; mirrored here for the scope gate.
ACCESS_KEYS = {
    "ak_readonly": {"agent": "reporting-bot", "scopes": ["users:read"]},
    "ak_readwrite": {"agent": "provisioner-bot", "scopes": ["users:read", "users:write"]},
}


class ExchangeReq(BaseModel):
    accessKey: str
    loginOptions: dict | None = None  # may carry customClaims.scopes


def _key(access_key: str) -> dict:
    rec = ACCESS_KEYS.get(access_key)
    if rec is None:
        raise HTTPException(401, "unknown access key")
    return rec


@app.post("/api/agent/exchange")
def exchange(body: ExchangeReq) -> dict:
    """Exchange a Descope access key for a scoped session JWT."""
    rec = _key(body.accessKey)
    # BUG (descope): we mint the session with whatever scopes the caller asked
    # for in loginOptions, instead of CLAMPING to the scopes Descope issued the
    # key. A read-only agent can request users:write and get it — privilege
    # escalation at exchange time.
    requested = ((body.loginOptions or {}).get("customClaims") or {}).get("scopes")
    scopes = requested if requested else rec["scopes"]
    token = jwt.encode({"sub": rec["agent"], "scopes": scopes}, SESSION_SECRET, algorithm="HS256")
    return {"sessionJwt": token, "scopes": scopes}


def _session(authorization: str) -> dict:
    token = authorization.replace("Bearer ", "", 1)
    if not token:
        raise HTTPException(401, "missing session")
    try:
        return jwt.decode(token, SESSION_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise HTTPException(401, "invalid session") from exc


@app.get("/api/agent/whoami")
def whoami(authorization: str = Header(default="")) -> dict:
    claims = _session(authorization)
    return {"agent": claims.get("sub"), "scopes": claims.get("scopes", [])}


class NewUser(BaseModel):
    loginId: str


@app.post("/api/tenant/users", status_code=201)
def create_user(body: NewUser, authorization: str = Header(default="")) -> dict:
    """Create a user — requires the users:write scope on the session."""
    claims = _session(authorization)
    if "users:write" not in claims.get("scopes", []):
        raise HTTPException(403, "missing scope users:write")
    return {"userId": "u_new", "loginId": body.loginId}
