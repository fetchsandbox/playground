"""Acme Notifications — Resend-powered transactional email API.

Surface:
  POST /signup             create a user, send welcome email
  POST /password-reset     send password-reset email
  POST /resend-webhook     receive Resend events + update user state
  GET  /users/{user_id}    return user with email_status
"""
from __future__ import annotations

import uuid

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, EmailStr
import resend

app = FastAPI(title="Acme Notifications")

RESEND_API_KEY = "re_demo"
RESEND_WEBHOOK_SECRET = "whsec_demo"
resend.api_key = RESEND_API_KEY

# In-memory store — would be Postgres in prod.
users: dict[str, dict] = {}


class SignupReq(BaseModel):
    email: EmailStr
    name: str


@app.post("/signup")
def signup(body: SignupReq) -> dict:
    user_id = f"user_{uuid.uuid4().hex[:8]}"
    users[user_id] = {
        "id": user_id,
        "email": body.email,
        "name": body.name,
        "email_status": "active",  # active | bounced | complained — we track this
    }

    # Send welcome email.
    resend.Emails.send({
        "from": "acme@acmenotifications.com",
        "to": body.email,
        "subject": "Welcome to Acme",
        "html": f"<p>Hey {body.name}, welcome aboard.</p>",
    })

    return users[user_id]


@app.post("/password-reset")
def password_reset(email: str) -> dict:
    # Send password-reset email.
    resend.Emails.send({
        "from": "acme@acmenotifications.com",
        "to": email,
        "subject": "Reset your password",
        "html": "<p>Click here to reset: https://acme.com/reset</p>",
    })
    return {"sent": True, "to": email}


@app.post("/resend-webhook")
async def resend_webhook(
    request: Request,
    svix_signature: str = Header(None),
) -> dict:
    """Handle Resend events.

    We listen for `email.delivered` so we can mark deliveries as
    successful in our user table. That's the only event we currently
    handle.
    """
    payload = await request.json()
    event_type = payload.get("type", "")

    if event_type == "email.delivered":
        email = payload.get("data", {}).get("to", [None])[0]
        for user_id, user in users.items():
            if user["email"] == email:
                users[user_id]["last_delivery_at"] = payload.get("created_at")
                break

    return {"received": True}


@app.get("/users/{user_id}")
def get_user(user_id: str) -> dict:
    user = users.get(user_id)
    if not user:
        raise HTTPException(404, "User not found")
    return user
