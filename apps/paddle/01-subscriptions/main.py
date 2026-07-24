"""Nimbus SaaS — subscription lifecycle API.

Surface:
  POST /webhook          receive Paddle subscription events
  GET  /subscriptions/{id}  subscription status + entitlement
"""
from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request

app = FastAPI(title="Nimbus SaaS")

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
            "status": "created",
            "customer_id": data.get("customer_id", ""),
            "plan_id": (data.get("items") or [{}])[0].get("price", {}).get("product_id", ""),
        }

    elif event_type == "subscription.activated":
        if sid in subscriptions:
            subscriptions[sid]["status"] = "active"

    elif event_type == "subscription.canceled":
        if sid in subscriptions:
            subscriptions[sid]["status"] = "canceled"

    return {"received": True}


@app.get("/subscriptions/{subscription_id}")
def get_subscription(subscription_id: str) -> dict:
    sub = subscriptions.get(subscription_id)
    if not sub:
        raise HTTPException(status_code=404, detail="Subscription not found")
    entitled = sub["status"] == "active"
    return {**sub, "entitled": entitled}
