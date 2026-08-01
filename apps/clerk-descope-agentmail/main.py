"""Acme HelpDesk — Clerk + Descope + AgentMail support platform.

Human customers authenticate via Clerk JWTs to open and view tickets.
AI support agents authenticate via Descope access keys (exchanged for
scoped session JWTs) to read and reply to tickets.
AgentMail provisions per-ticket inboxes and delivers email replies.

Surface:
  POST /api/customer/tickets              open a ticket, provision AgentMail inbox
  GET  /api/customer/tickets              list my tickets (owner-scoped)
  GET  /api/customer/tickets/{id}         view ticket + thread (owner or admin)

  POST /api/agent/exchange                exchange Descope access key for session JWT
  GET  /api/agent/whoami                  agent identity + granted scopes
  GET  /api/agent/tickets                 list open tickets  [tickets:read]
  POST /api/agent/tickets/{id}/reply      send reply via AgentMail  [tickets:write]
  PATCH /api/agent/tickets/{id}/status    mark open / resolved  [tickets:write]

  POST /api/webhooks/clerk                Clerk user.created / user.deleted
  POST /api/webhooks/agentmail            AgentMail message.received → append thread
"""
from __future__ import annotations

import uuid

import httpx
import jwt
from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, EmailStr

app = FastAPI(title="Acme HelpDesk")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CLERK_JWT_PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\nMOCK\n-----END PUBLIC KEY-----"
CLERK_WEBHOOK_SECRET = "whsec_clerk_demo"

DESCOPE_PROJECT_ID = "P2abc123demo"
SESSION_SECRET = "dev-only-not-for-prod"

AGENTMAIL_API_KEY = "am_demo"
AGENTMAIL_BASE = "https://api.agentmail.to/v1"

# ---------------------------------------------------------------------------
# In-memory stores
# ---------------------------------------------------------------------------

# clerk_user_id → {id, email, role}
users: dict[str, dict] = {}

# ticket_id → {id, owner_id, subject, agentmail_inbox_id,
#               agentmail_address, messages, status}
tickets: dict[str, dict] = {}

# Descope access keys mirrored locally with granted scopes.
ACCESS_KEYS: dict[str, dict] = {
    "ak_readonly": {"agent": "reader-bot",   "scopes": ["tickets:read"]},
    "ak_readwrite": {"agent": "resolver-bot", "scopes": ["tickets:read", "tickets:write"]},
}

# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------


def _decode_clerk_jwt(token: str) -> dict:
    return jwt.decode(token, options={"verify_signature": False})


def _require_clerk(authorization: str) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing Clerk bearer token")
    claims = _decode_clerk_jwt(authorization.removeprefix("Bearer "))
    user_id = claims.get("sub")
    if not user_id:
        raise HTTPException(401, "No subject claim in Clerk JWT")
    return claims


def _decode_session(authorization: str) -> dict:
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(401, "Missing Descope session token")
    try:
        return jwt.decode(token, SESSION_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise HTTPException(401, "Invalid session token") from exc


def _require_scope(claims: dict, scope: str) -> None:
    if scope not in claims.get("scopes", []):
        raise HTTPException(403, f"Missing scope: {scope}")


# ---------------------------------------------------------------------------
# Customer routes  (Clerk JWT)
# ---------------------------------------------------------------------------


class CreateTicketReq(BaseModel):
    subject: str
    body: str


@app.post("/api/customer/tickets", status_code=201)
def create_ticket(
    body: CreateTicketReq,
    authorization: str = Header(default=""),
) -> dict:
    claims = _require_clerk(authorization)
    user_id = claims["sub"]

    ticket_id = f"tkt_{uuid.uuid4().hex[:8]}"

    with httpx.Client() as client:
        resp = client.post(
            f"{AGENTMAIL_BASE}/inboxes",
            headers={"Authorization": f"Bearer {AGENTMAIL_API_KEY}"},
            json={"alias": f"ticket-{ticket_id}"},
        )
        if resp.status_code >= 400:
            raise HTTPException(502, "Failed to provision AgentMail inbox")
        inbox = resp.json()

    ticket = {
        "id": ticket_id,
        "owner_id": user_id,
        "subject": body.subject,
        "agentmail_inbox_id": inbox.get("id"),
        "agentmail_address": inbox.get("address"),
        "messages": [{"from": claims.get("email", user_id), "body": body.body}],
        "status": "open",
    }
    tickets[ticket_id] = ticket
    return ticket


@app.get("/api/customer/tickets")
def list_my_tickets(authorization: str = Header(default="")) -> list[dict]:
    claims = _require_clerk(authorization)
    user_id = claims["sub"]
    return [t for t in tickets.values() if t["owner_id"] == user_id]


@app.get("/api/customer/tickets/{ticket_id}")
def get_ticket(ticket_id: str, authorization: str = Header(default="")) -> dict:
    claims = _require_clerk(authorization)
    user_id = claims["sub"]
    role = claims.get("public_metadata", {}).get("role", "member")

    ticket = tickets.get(ticket_id)
    if not ticket:
        raise HTTPException(404, "Ticket not found")

    # BUG: checks agentmail_inbox_id instead of owner_id — any authed user
    # can read any ticket.
    if role != "admin" and ticket["agentmail_inbox_id"] != user_id:
        raise HTTPException(403, "Not your ticket")

    return ticket


# ---------------------------------------------------------------------------
# Agent routes  (Descope access key → session JWT)
# ---------------------------------------------------------------------------


class ExchangeReq(BaseModel):
    accessKey: str
    loginOptions: dict | None = None


@app.post("/api/agent/exchange")
def agent_exchange(body: ExchangeReq) -> dict:
    rec = ACCESS_KEYS.get(body.accessKey)
    if not rec:
        raise HTTPException(401, "Unknown access key")
    requested = ((body.loginOptions or {}).get("customClaims") or {}).get("scopes")
    scopes = requested if requested else rec["scopes"]
    token = jwt.encode({"sub": rec["agent"], "scopes": scopes}, SESSION_SECRET, algorithm="HS256")
    return {"sessionJwt": token, "scopes": scopes}


@app.get("/api/agent/whoami")
def agent_whoami(authorization: str = Header(default="")) -> dict:
    claims = _decode_session(authorization)
    return {"agent": claims.get("sub"), "scopes": claims.get("scopes", [])}


@app.get("/api/agent/tickets")
def agent_list_tickets(authorization: str = Header(default="")) -> list[dict]:
    claims = _decode_session(authorization)
    _require_scope(claims, "tickets:read")
    return [t for t in tickets.values() if t["status"] == "open"]


class ReplyReq(BaseModel):
    body: str


@app.post("/api/agent/tickets/{ticket_id}/reply")
def agent_reply(
    ticket_id: str,
    body: ReplyReq,
    authorization: str = Header(default=""),
) -> dict:
    claims = _decode_session(authorization)
    _require_scope(claims, "tickets:write")

    ticket = tickets.get(ticket_id)
    if not ticket:
        raise HTTPException(404, "Ticket not found")

    # BUG: passes agentmail_inbox_id as the path segment but AgentMail's send
    # endpoint expects the inbox id in the URL, not agentmail_address — the
    # wrong field is used so the send request always 404s on AgentMail's side.
    with httpx.Client() as client:
        client.post(
            f"{AGENTMAIL_BASE}/inboxes/{ticket['agentmail_address']}/send",
            headers={"Authorization": f"Bearer {AGENTMAIL_API_KEY}"},
            json={
                "to": tickets[ticket_id]["messages"][0]["from"],
                "subject": f"Re: {ticket['subject']}",
                "html": f"<p>{body.body}</p>",
            },
        )

    tickets[ticket_id]["messages"].append({"from": ticket["agentmail_address"], "body": body.body})
    return {"sent": True}


class StatusReq(BaseModel):
    status: str  # "open" or "resolved"


@app.patch("/api/agent/tickets/{ticket_id}/status")
def agent_update_status(
    ticket_id: str,
    body: StatusReq,
    authorization: str = Header(default=""),
) -> dict:
    claims = _decode_session(authorization)
    _require_scope(claims, "tickets:write")

    ticket = tickets.get(ticket_id)
    if not ticket:
        raise HTTPException(404, "Ticket not found")
    if body.status not in ("open", "resolved"):
        raise HTTPException(422, "status must be 'open' or 'resolved'")

    tickets[ticket_id]["status"] = body.status
    return tickets[ticket_id]


# ---------------------------------------------------------------------------
# Webhook routes
# ---------------------------------------------------------------------------


@app.post("/api/webhooks/clerk")
async def clerk_webhook(request: Request) -> dict:
    payload = await request.json()
    event_type = payload.get("type", "")
    data = payload.get("data", {})

    if event_type == "user.created":
        user_id = data.get("id")
        if user_id:
            users[user_id] = {
                "id": user_id,
                "email": (data.get("email_addresses") or [{}])[0].get("email_address"),
                "role": "member",
            }

    elif event_type == "user.deleted":
        users.pop(data.get("id", ""), None)

    return {"received": True}


@app.post("/api/webhooks/agentmail")
async def agentmail_webhook(request: Request) -> dict:
    payload = await request.json()
    event_type = payload.get("event_type", "")

    if event_type == "message.received":
        message = payload.get("message", {})
        inbox_id = message.get("inbox_id")

        for ticket in tickets.values():
            if ticket.get("agentmail_inbox_id") == inbox_id:
                ticket["messages"].append({
                    "from": message.get("from"),
                    "body": message.get("text") or message.get("html"),
                })
                break

    return {"received": True}
