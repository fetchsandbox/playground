"""Apex Recover — dunning and payment recovery service.

Surface:
  POST /webhook              receive Paddle subscription and transaction events
  GET  /accounts/{id}        account standing and access status
"""
from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request

app = FastAPI(title="Apex Recover")

accounts: dict[str, dict] = {}


@app.post("/webhook")
async def paddle_webhook(request: Request) -> dict:
    event = await request.json()
    event_type = event.get("event_type", "")
    data = event.get("data", {})

    if event_type == "subscription.created":
        sid = data.get("id", "")
        customer_id = data.get("customer_id", "")
        accounts[customer_id] = {
            "customer_id": customer_id,
            "subscription_id": sid,
            "status": "created",
            "access": False,
        }

    elif event_type == "subscription.activated":
        customer_id = data.get("customer_id", "")
        if customer_id in accounts:
            accounts[customer_id]["status"] = "active"
            accounts[customer_id]["access"] = True

    elif event_type == "transaction.payment_failed":
        customer_id = data.get("customer_id", "")
        if customer_id in accounts:
            accounts[customer_id]["status"] = "past_due"
            accounts[customer_id]["access"] = False

    return {"received": True}


@app.get("/accounts/{customer_id}")
def get_account(customer_id: str) -> dict:
    acc = accounts.get(customer_id)
    if not acc:
        raise HTTPException(status_code=404, detail="Account not found")
    return acc
