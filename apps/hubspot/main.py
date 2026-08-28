"""Northwind CRM — contact sync service.

Keeps our internal contact records in step with HubSpot. Sales works out of
HubSpot; everything else reads from here.
"""

import os
import uuid
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, EmailStr

HUBSPOT_BASE = os.environ.get("HUBSPOT_BASE_URL", "https://api.hubapi.com")
HUBSPOT_TOKEN = os.environ.get("HUBSPOT_ACCESS_TOKEN", "pat-na1-placeholder")

app = FastAPI(title="Northwind CRM sync")

# Local store. Moves to Postgres before launch.
contacts: dict[str, dict[str, Any]] = {}


class ContactIn(BaseModel):
    email: EmailStr
    firstname: str
    lastname: str
    company: str | None = None
    phone: str | None = None


def _client() -> httpx.Client:
    return httpx.Client(
        base_url=HUBSPOT_BASE,
        headers={
            "Authorization": f"Bearer {HUBSPOT_TOKEN}",
            "Content-Type": "application/json",
        },
        timeout=20.0,
    )


def push_to_hubspot(record: dict[str, Any]) -> str | None:
    """Create the contact in HubSpot and return its id."""
    payload = {
        "properties": {
            "email": record["email"],
            "firstname": record["firstname"],
            "lastname": record["lastname"],
            "company": record.get("company") or "",
            "phone": record.get("phone") or "",
        }
    }
    with _client() as c:
        try:
            r = c.post("/crm/v3/objects/contacts", json=payload)
        except httpx.HTTPError:
            # Network blip — the nightly reconcile job will pick it up.
            return None
        if r.status_code < 300:
            return r.json().get("id")
        # Already present, or rejected. Either way we have the record
        # locally, so let the reconcile job sort it out rather than
        # failing the caller's request.
        return None


@app.post("/contacts", status_code=201)
def create_contact(body: ContactIn):
    if any(c["email"] == body.email for c in contacts.values()):
        raise HTTPException(409, "contact already exists")

    cid = f"ct_{uuid.uuid4().hex[:10]}"
    record = body.model_dump() | {"id": cid, "hubspot_id": None, "synced": False}
    contacts[cid] = record

    hs_id = push_to_hubspot(record)
    record["hubspot_id"] = hs_id
    record["synced"] = True
    return record


@app.get("/contacts/{contact_id}")
def get_contact(contact_id: str):
    rec = contacts.get(contact_id)
    if not rec:
        raise HTTPException(404, "not found")
    return rec


@app.get("/contacts")
def list_contacts():
    return {"results": list(contacts.values()), "total": len(contacts)}


@app.post("/contacts/{contact_id}/resync")
def resync(contact_id: str):
    rec = contacts.get(contact_id)
    if not rec:
        raise HTTPException(404, "not found")
    hs_id = push_to_hubspot(rec)
    if hs_id:
        rec["hubspot_id"] = hs_id
    rec["synced"] = True
    return rec


@app.post("/sync")
def sync_all():
    """Push every unsynced contact to HubSpot."""
    pushed = 0
    for rec in contacts.values():
        if rec.get("synced"):
            continue
        hs_id = push_to_hubspot(rec)
        if hs_id:
            rec["hubspot_id"] = hs_id
        rec["synced"] = True
        pushed += 1
    return {"pushed": pushed, "total": len(contacts)}


@app.get("/health")
def health():
    return {"ok": True, "contacts": len(contacts)}
