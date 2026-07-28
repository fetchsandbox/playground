"""Nova Checkout — checkout and seat provisioning service.

Surface:
  POST /webhook            receive Paddle checkout and subscription events
  GET  /workspaces/{id}    workspace seat count and status
"""
from __future__ import annotations

from fastapi import FastAPI, Request

app = FastAPI(title="Nova Checkout")

workspaces: dict[str, dict] = {}


def _provision_seats(workspace_id: str, seats: int) -> None:
    ws = workspaces.setdefault(workspace_id, {"seats": 0, "status": "inactive", "provision_count": 0})
    ws["seats"] += seats
    ws["status"] = "active"
    ws["provision_count"] += 1


@app.post("/webhook")
async def paddle_webhook(request: Request) -> dict:
    event = await request.json()
    event_type = event.get("event_type", "")
    data = event.get("data", {})
    custom_data = data.get("custom_data") or {}
    workspace_id = custom_data.get("workspace_id", "")

    if event_type == "transaction.completed":
        items = data.get("details", {}).get("line_items") or []
        seats = sum(int(item.get("quantity", 1)) for item in items)
        if workspace_id:
            _provision_seats(workspace_id, seats)

    elif event_type == "subscription.created":
        items = data.get("items") or []
        seats = sum(int(item.get("quantity", 1)) for item in items)
        if workspace_id:
            _provision_seats(workspace_id, seats)

    return {"received": True}


@app.get("/workspaces/{workspace_id}")
def get_workspace(workspace_id: str) -> dict:
    ws = workspaces.get(workspace_id)
    if not ws:
        return {"workspace_id": workspace_id, "seats": 0, "status": "inactive"}
    return {"workspace_id": workspace_id, **ws}
