"""Acme Reminders — Surge-powered SMS reminders for appointments.

Surface:
  POST /api/contacts                add a customer contact with phone
  POST /api/appointments/{id}/remind  send appointment reminder SMS
  POST /api/surge-webhook           receive Surge events (delivery, opt-out)
  GET  /api/contacts/{id}           fetch contact with SMS status
"""
from __future__ import annotations

import uuid

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel
import httpx

app = FastAPI(title="Acme Reminders")

SURGE_API_KEY = "surge_demo"
SURGE_ACCOUNT_ID = "act_demo"
SURGE_WEBHOOK_SECRET = "whsec_demo"
SURGE_BASE = "https://api.surge.app"

# Tiny in-memory store — Postgres in prod.
contacts: dict[str, dict] = {}
appointments: dict[str, dict] = {
    "appt_demo_1": {"id": "appt_demo_1", "contact_id": "ct_demo_1", "time": "2026-06-25T14:00:00Z"},
}


class CreateContactReq(BaseModel):
    name: str
    phone: str  # E.164 format expected


@app.post("/api/contacts")
def create_contact(body: CreateContactReq) -> dict:
    contact_id = f"ct_{uuid.uuid4().hex[:8]}"
    contacts[contact_id] = {
        "id": contact_id,
        "name": body.name,
        "phone": body.phone,
        "sms_status": "active",
    }
    return contacts[contact_id]


@app.post("/api/appointments/{appointment_id}/remind")
def send_reminder(appointment_id: str) -> dict:
    """Send a reminder SMS for the appointment."""
    appt = appointments.get(appointment_id)
    if not appt:
        raise HTTPException(404, "Appointment not found")

    contact = contacts.get(appt["contact_id"])
    if not contact:
        raise HTTPException(404, "Contact not found")

    # Send via Surge API.
    with httpx.Client() as client:
        resp = client.post(
            f"{SURGE_BASE}/accounts/{SURGE_ACCOUNT_ID}/messages",
            headers={"Authorization": f"Bearer {SURGE_API_KEY}"},
            json={
                "to": contact["phone"],
                "body": f"Hey {contact['name']}, reminder about your appointment on {appt['time']}.",
            },
        )

    return {"sent": True, "to": contact["phone"], "message_id": resp.json().get("id")}


@app.post("/api/surge-webhook")
async def surge_webhook(
    request: Request,
    surge_signature: str = Header(None),
) -> dict:
    """Handle Surge events.

    We listen for `message.delivered` to mark deliveries successful.
    """
    payload = await request.json()
    event_type = payload.get("type", "")

    if event_type == "message.delivered":
        phone = payload.get("data", {}).get("to")
        for contact_id, contact in contacts.items():
            if contact["phone"] == phone:
                contacts[contact_id]["last_delivery_at"] = payload.get("created_at")
                break

    return {"received": True}


@app.get("/api/contacts/{contact_id}")
def get_contact(contact_id: str) -> dict:
    contact = contacts.get(contact_id)
    if not contact:
        raise HTTPException(404, "Contact not found")
    return contact
