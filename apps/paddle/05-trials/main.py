"""Helix Trial — trial-to-paid conversion API.

Surface:
  POST /webhook              receive Paddle subscription events
  GET  /access/{sub_id}      check trial or paid access
"""
from __future__ import annotations

from fastapi import FastAPI, Request

app = FastAPI(title="Helix Trial")

subscriptions: dict[str, dict] = {}


@app.post("/webhook")
async def paddle_webhook(request: Request) -> dict:
    event = await request.json()
    event_type = event.get("event_type", "")
    data = event.get("data", {})
    sid = data.get("id", "")

    if event_type == "subscription.created":
        subscriptions[sid] = {
            "id": sid,
            "customer_id": data.get("customer_id", ""),
            "status": "created",
        }

    elif event_type == "subscription.trialing":
        if sid in subscriptions:
            subscriptions[sid]["status"] = "trialing"
            subscriptions[sid]["trial_ends_at"] = data.get("next_billed_at", "")

    elif event_type == "subscription.activated":
        if sid in subscriptions and subscriptions[sid]["status"] == "trialing":
            subscriptions[sid]["status"] = "active"
            subscriptions[sid].pop("trial_ends_at", None)

    elif event_type == "subscription.canceled":
        if sid in subscriptions:
            subscriptions[sid]["status"] = "canceled"

    return {"received": True}


@app.get("/access/{subscription_id}")
def check_access(subscription_id: str) -> dict:
    sub = subscriptions.get(subscription_id)
    if not sub:
        return {"subscription_id": subscription_id, "access": False, "reason": "not_found"}
    if sub["status"] in ("trialing", "active"):
        return {"subscription_id": subscription_id, "access": True, "status": sub["status"]}
    return {"subscription_id": subscription_id, "access": False, "status": sub["status"]}
