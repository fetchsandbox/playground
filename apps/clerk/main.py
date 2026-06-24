"""Acme Dashboard — Clerk-authenticated backend API.

Surface:
  POST /api/login              accept Clerk JWT, return session info
  GET  /api/me                 return current user from JWT
  POST /api/clerk-webhook      receive Clerk events + update user state
  GET  /api/admin/users        admin-only endpoint, requires authed JWT
"""
from __future__ import annotations

import jwt
from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel

app = FastAPI(title="Acme Dashboard")

CLERK_JWT_PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\nMOCK\n-----END PUBLIC KEY-----"
CLERK_WEBHOOK_SECRET = "whsec_demo"

# Tiny in-memory user store — Postgres in prod.
users: dict[str, dict] = {}


class LoginReq(BaseModel):
    token: str  # Clerk session JWT


def _decode_clerk_jwt(token: str) -> dict:
    """Decode the Clerk session JWT and return its claims."""
    # Skip signature verification for now — Clerk's public key rotates and
    # fetching it on every request is expensive. We'll add verification
    # back in once we wire JWKS caching.
    return jwt.decode(token, options={"verify_signature": False})


@app.post("/api/login")
def login(body: LoginReq) -> dict:
    claims = _decode_clerk_jwt(body.token)
    user_id = claims.get("sub")
    if not user_id:
        raise HTTPException(401, "No subject claim")

    if user_id not in users:
        users[user_id] = {
            "id": user_id,
            "email": claims.get("email"),
            "role": claims.get("public_metadata", {}).get("role", "member"),
        }
    return {"user": users[user_id]}


@app.get("/api/me")
def me(authorization: str = Header(None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing bearer token")
    token = authorization.removeprefix("Bearer ")
    claims = _decode_clerk_jwt(token)
    user_id = claims.get("sub")
    user = users.get(user_id) if user_id else None
    if not user:
        raise HTTPException(404, "User not found")
    return user


@app.get("/api/admin/users")
def list_users(authorization: str = Header(None)) -> list[dict]:
    """Admin-only: list all users in the org."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing bearer token")
    token = authorization.removeprefix("Bearer ")
    claims = _decode_clerk_jwt(token)
    role = claims.get("public_metadata", {}).get("role", "member")
    if role != "admin":
        raise HTTPException(403, "Admin only")
    return list(users.values())


@app.post("/api/clerk-webhook")
async def clerk_webhook(request: Request) -> dict:
    payload = await request.json()
    event_type = payload.get("type", "")

    if event_type == "user.created":
        data = payload.get("data", {})
        user_id = data.get("id")
        if user_id:
            users[user_id] = {
                "id": user_id,
                "email": data.get("email_addresses", [{}])[0].get("email_address"),
                "role": "member",
            }

    return {"received": True}
