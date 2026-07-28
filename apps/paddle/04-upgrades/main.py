"""Orion Plans — subscription plan management API.

Surface:
  POST /webhook             receive Paddle subscription events
  GET  /subscriptions/{id}  current plan and status
"""
from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request

app = FastAPI(title="Orion Plans")

subscriptions: dict[str, dict] = {}


@app.post("/webhook")
async def paddle_webhook(request: Request) -> dict:
    event = await request.json()
    event_type = event.get("event_type", "")
    data = event.get("data", {})
    sid = data.get("id", "")
    occurred_at = event.get("occurred_at", "")

    if event_type == "subscription.created":
        items = data.get("items") or []
        plan_id = items[0].get("price", {}).get("product_id", "") if items else ""
        subscriptions[sid] = {
            "id": sid,
            "customer_id": data.get("customer_id", ""),
            "plan_id": plan_id,
            "status": "created",
            "updated_at": occurred_at,
        }

    elif event_type == "subscription.activated":
        if sid in subscriptions:
            subscriptions[sid]["status"] = "active"
            subscriptions[sid]["updated_at"] = occurred_at

    elif event_type == "subscription.updated":
        if sid in subscriptions:
            items = data.get("items") or []
            plan_id = items[0].get("price", {}).get("product_id", "") if items else subscriptions[sid]["plan_id"]
            subscriptions[sid]["plan_id"] = plan_id
            subscriptions[sid]["updated_at"] = occurred_at

    return {"received": True}


@app.get("/subscriptions/{subscription_id}")
def get_subscription(subscription_id: str) -> dict:
    sub = subscriptions.get(subscription_id)
    if not sub:
        raise HTTPException(status_code=404, detail="Subscription not found")
    return sub
