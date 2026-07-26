"""Helix Trial — trial-to-paid conversion API.

Surface:
  POST /webhook              receive Paddle subscription events
  GET  /access/{sub_id}      check trial or paid access
"""
from __future__ import annotations

import logging

from fastapi import FastAPI, Request

logger = logging.getLogger(__name__)
app = FastAPI(title="Helix Trial")

subscriptions: dict[str, dict] = {}

HANDLED_EVENTS = {
    "subscription.created",
    "subscription.trialing",
    "subscription.activated",
    "subscription.canceled",
}


def _upsert(sid: str, data: dict) -> dict:
    if sid not in subscriptions:
        subscriptions[sid] = {
            "id": sid,
            "customer_id": data.get("customer_id", ""),
            "status": "created",
        }
    return subscriptions[sid]


@app.post("/webhook")
async def paddle_webhook(request: Request) -> dict:
    event = await request.json()
    event_type = event.get("event_type", "")
    data = event.get("data", {})
    sid = data.get("id", "")

    if event_type not in HANDLED_EVENTS:
        logger.warning("unhandled paddle event type: %s", event_type)
        return {"received": True}

    if event_type == "subscription.created":
        subscriptions[sid] = {
            "id": sid,
            "customer_id": data.get("customer_id", ""),
            "status": "created",
        }

    elif event_type == "subscription.trialing":
        sub = _upsert(sid, data)
        sub["status"] = "trialing"
        sub["trial_ends_at"] = data.get("next_billed_at", "")

    elif event_type == "subscription.activated":
        sub = _upsert(sid, data)
        if sub["status"] != "canceled":
            sub["status"] = "active"
            sub.pop("trial_ends_at", None)

    elif event_type == "subscription.canceled":
        sub = _upsert(sid, data)
        sub["status"] = "canceled"

    return {"received": True}


@app.get("/access/{subscription_id}")
def check_access(subscription_id: str) -> dict:
    sub = subscriptions.get(subscription_id)
    if not sub:
        return {"subscription_id": subscription_id, "access": False, "reason": "not_found"}
    if sub["status"] in ("trialing", "active"):
        return {"subscription_id": subscription_id, "access": True, "status": sub["status"]}
    return {"subscription_id": subscription_id, "access": False, "status": sub["status"]}
