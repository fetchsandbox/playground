"""Grid Seats — per-seat subscription management API.

Surface:
  POST /webhook              receive Paddle subscription events
  GET  /teams/{id}           team seat allocation and status
"""
from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request

app = FastAPI(title="Grid Seats")

teams: dict[str, dict] = {}


@app.post("/webhook")
async def paddle_webhook(request: Request) -> dict:
    event = await request.json()
    event_type = event.get("event_type", "")
    data = event.get("data", {})
    custom_data = data.get("custom_data") or {}
    team_id = custom_data.get("team_id", "")
    occurred_at = event.get("occurred_at", "")

    if event_type == "subscription.created":
        items = data.get("items") or []
        seats = items[0].get("quantity", 1) if items else 1
        if team_id:
            teams[team_id] = {
                "team_id": team_id,
                "subscription_id": data.get("id", ""),
                "seats": seats,
                "status": "created",
                "updated_at": occurred_at,
            }

    elif event_type == "subscription.activated":
        if team_id in teams:
            teams[team_id]["status"] = "active"
            teams[team_id]["updated_at"] = occurred_at

    elif event_type == "subscription.updated":
        if team_id in teams:
            items = data.get("items") or []
            seats = items[0].get("quantity", teams[team_id]["seats"]) if items else teams[team_id]["seats"]
            teams[team_id]["seats"] = seats

    return {"received": True}


@app.get("/teams/{team_id}")
def get_team(team_id: str) -> dict:
    team = teams.get(team_id)
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    return team
