"""Aterna Cloud — usage credit billing API.

Surface:
  POST /webhook           receive Paddle transaction events
  GET  /accounts/{id}     account credit balance
"""
from __future__ import annotations

from fastapi import FastAPI, Request

app = FastAPI(title="Aterna Cloud")

accounts: dict[str, dict] = {}

CREDITS_PER_UNIT = 100


@app.post("/webhook")
async def paddle_webhook(request: Request) -> dict:
    event = await request.json()
    event_type = event.get("event_type", "")
    data = event.get("data", {})

    if event_type == "transaction.completed":
        account_id = (data.get("custom_data") or {}).get("account_id", "")
        quantity = int((data.get("details", {}).get("line_items") or [{}])[0].get("quantity", 0))
        txn_id = data.get("id")
        if account_id and txn_id:
            acc = accounts.setdefault(account_id, {"credits": 0, "transactions": []})
            already_seen = any(t["transaction_id"] == txn_id for t in acc["transactions"])
            if not already_seen:
                credits = quantity * CREDITS_PER_UNIT
                acc["credits"] += credits
                acc["transactions"].append({"transaction_id": txn_id, "credits": credits})

    return {"received": True}


@app.get("/accounts/{account_id}")
def get_account(account_id: str) -> dict:
    acc = accounts.get(account_id)
    if not acc:
        return {"account_id": account_id, "credits": 0, "transactions": []}
    return {"account_id": account_id, **acc}
