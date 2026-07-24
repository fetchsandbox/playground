"""Pulse Billing — transaction and refund lifecycle service.

Surface:
  POST /webhook              receive Paddle transaction events
  GET  /licenses/{id}        license status and access
"""
from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request

app = FastAPI(title="Pulse Billing")

licenses: dict[str, dict] = {}


@app.post("/webhook")
async def paddle_webhook(request: Request) -> dict:
    event = await request.json()
    event_type = event.get("event_type", "")
    data = event.get("data", {})
    transaction_id = data.get("id", "")
    custom_data = data.get("custom_data") or {}
    license_id = custom_data.get("license_id", "")

    if event_type == "transaction.completed":
        if license_id:
            licenses[license_id] = {
                "license_id": license_id,
                "transaction_id": transaction_id,
                "status": "active",
                "access": True,
            }

    elif event_type == "transaction.refunded":
        if license_id in licenses:
            licenses[license_id]["status"] = "refunded"
            licenses[license_id]["access"] = False

    return {"received": True}


@app.get("/licenses/{license_id}")
def get_license(license_id: str) -> dict:
    lic = licenses.get(license_id)
    if not lic:
        raise HTTPException(status_code=404, detail="License not found")
    return lic
