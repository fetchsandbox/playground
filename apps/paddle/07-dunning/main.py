"""Apex Recover — dunning and payment recovery service.

Surface:
  POST /webhook              receive Paddle subscription and transaction events
  GET  /accounts/{id}        account standing and access status
"""
from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request

app = FastAPI(title="Apex Recover")

accounts: dict[str, dict] = {}
processed_events: set[str] = set()

_ACCESS_STATUSES = {"active", "trialing"}


def _compute_access(status: str) -> bool:
    return status in _ACCESS_STATUSES


@app.post("/webhook")
async def paddle_webhook(request: Request) -> dict:
    event = await request.json()
    event_id = event.get("id", "")
    if event_id and event_id in processed_events:
        return {"received": True}
    if event_id:
        processed_events.add(event_id)

    event_type = event.get("event_type", "")
    data = event.get("data", {})

    if event_type == "subscription.created":
        sid = data.get("id", "")
        customer_id = data.get("customer_id", "")
        accounts[customer_id] = {
            "customer_id": customer_id,
            "subscription_id": sid,
            "status": "created",
        }

    elif event_type == "subscription.activated":
        customer_id = data.get("customer_id", "")
        if customer_id in accounts:
            accounts[customer_id]["status"] = "active"

    elif event_type == "subscription.past_due":
        customer_id = data.get("customer_id", "")
        if customer_id in accounts:
            accounts[customer_id]["status"] = "past_due"

    elif event_type == "subscription.paused":
        customer_id = data.get("customer_id", "")
        if customer_id in accounts:
            accounts[customer_id]["status"] = "paused"

    elif event_type == "subscription.resumed":
        customer_id = data.get("customer_id", "")
        if customer_id in accounts:
            accounts[customer_id]["status"] = "active"

    elif event_type == "subscription.canceled":
        customer_id = data.get("customer_id", "")
        if customer_id in accounts:
            accounts[customer_id]["status"] = "canceled"

    elif event_type == "transaction.payment_failed":
        customer_id = data.get("customer_id", "")
        if customer_id in accounts:
            accounts[customer_id]["status"] = "past_due"

    elif event_type == "transaction.payment_succeeded":
        customer_id = data.get("customer_id", "")
        if customer_id in accounts:
            accounts[customer_id]["status"] = "active"

    return {"received": True}


@app.get("/accounts/{customer_id}")
def get_account(customer_id: str) -> dict:
    acc = accounts.get(customer_id)
    if not acc:
        raise HTTPException(status_code=404, detail="Account not found")
    return {**acc, "access": _compute_access(acc["status"])}
