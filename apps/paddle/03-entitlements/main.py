"""Velo Access — feature entitlement gate.

Surface:
  POST /webhook               receive Paddle subscription events
  GET  /entitlements/{sub_id} check feature access for a subscription
"""
from __future__ import annotations

from fastapi import FastAPI, Request

app = FastAPI(title="Velo Access")

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
            "status": data.get("status", "active"),
        }

    elif event_type == "subscription.trialing":
        subscriptions[sid] = {
            "id": sid,
            "customer_id": data.get("customer_id", ""),
            "status": "trialing",
        }

    elif event_type == "subscription.activated":
        existing = subscriptions.get(sid, {"id": sid, "customer_id": data.get("customer_id", "")})
        existing["status"] = "active"
        subscriptions[sid] = existing

    elif event_type == "subscription.canceled":
        subscriptions.pop(sid, None)

    return {"received": True}


@app.get("/entitlements/{subscription_id}")
def check_entitlement(subscription_id: str) -> dict:
    sub = subscriptions.get(subscription_id)
    if not sub or sub["status"] not in ("active", "trialing"):
        return {"subscription_id": subscription_id, "entitled": False}
    return {"subscription_id": subscription_id, "entitled": True, "status": sub["status"]}
