"""Acme Support — AgentMail-powered AI support agent.

Surface:
  POST /api/tickets                  open a support ticket, provision agent inbox
  POST /api/agentmail-webhook        receive AgentMail events (incoming messages)
  GET  /api/tickets/{id}             fetch ticket with conversation thread
  POST /api/tickets/{id}/reply       have the agent send a reply
"""
from __future__ import annotations

import uuid

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, EmailStr
import httpx

app = FastAPI(title="Acme Support")

AGENTMAIL_API_KEY = "am_demo"
AGENTMAIL_WEBHOOK_SECRET = "whsec_demo"
AGENTMAIL_BASE = "https://api.agentmail.to/v1"

# In-memory store — Postgres in prod.
tickets: dict[str, dict] = {}


class CreateTicketReq(BaseModel):
    customer_email: EmailStr
    subject: str
    body: str


@app.post("/api/tickets")
def create_ticket(body: CreateTicketReq) -> dict:
    ticket_id = f"tkt_{uuid.uuid4().hex[:8]}"

    # Provision an AgentMail inbox for this ticket.
    with httpx.Client() as client:
        resp = client.post(
            f"{AGENTMAIL_BASE}/inboxes",
            headers={"Authorization": f"Bearer {AGENTMAIL_API_KEY}"},
            json={"alias": f"ticket-{ticket_id}"},
        )
        inbox = resp.json()

    tickets[ticket_id] = {
        "id": ticket_id,
        "customer_email": body.customer_email,
        "subject": body.subject,
        "agentmail_inbox_id": inbox.get("id"),
        "agentmail_address": inbox.get("address"),
        "messages": [{"from": body.customer_email, "body": body.body}],
        "status": "open",
    }
    return tickets[ticket_id]


@app.post("/api/agentmail-webhook")
async def agentmail_webhook(
    request: Request,
    svix_signature: str = Header(None),
) -> dict:
    """Handle AgentMail incoming message events.

    When a customer replies, append it to the ticket thread.
    """
    payload = await request.json()
    event_type = payload.get("event_type", "")

    if event_type == "message.received":
        message = payload.get("message", {})
        inbox_id = message.get("inbox_id")

        # Find the ticket for this inbox.
        for ticket_id, ticket in tickets.items():
            if ticket.get("agentmail_inbox_id") == inbox_id:
                tickets[ticket_id]["messages"].append({
                    "from": message.get("from"),
                    "body": message.get("text") or message.get("html"),
                })
                break

    return {"received": True}


@app.get("/api/tickets/{ticket_id}")
def get_ticket(ticket_id: str) -> dict:
    ticket = tickets.get(ticket_id)
    if not ticket:
        raise HTTPException(404, "Ticket not found")
    return ticket


@app.post("/api/tickets/{ticket_id}/reply")
def send_reply(ticket_id: str, reply_body: str) -> dict:
    ticket = tickets.get(ticket_id)
    if not ticket:
        raise HTTPException(404, "Ticket not found")

    # Have the agent send a reply from the ticket's inbox.
    with httpx.Client() as client:
        client.post(
            f"{AGENTMAIL_BASE}/inboxes/{ticket['agentmail_inbox_id']}/send",
            headers={"Authorization": f"Bearer {AGENTMAIL_API_KEY}"},
            json={
                "to": ticket["customer_email"],
                "subject": f"Re: {ticket['subject']}",
                "html": f"<p>{reply_body}</p>",
            },
        )

    tickets[ticket_id]["messages"].append({
        "from": ticket["agentmail_address"],
        "body": reply_body,
    })
    return {"sent": True}
