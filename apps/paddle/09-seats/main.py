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
            team = teams.setdefault(team_id, {
                "team_id": team_id,
                "subscription_id": data.get("id", ""),
                "seats": seats,
                "status": data.get("status", "created"),
                "updated_at": occurred_at,
            })
            team["subscription_id"] = data.get("id", team.get("subscription_id", ""))
            team["seats"] = seats
            team["status"] = data.get("status", team.get("status", "created"))
            team["updated_at"] = occurred_at

    elif event_type == "subscription.activated":
        team = teams.setdefault(team_id, {
            "team_id": team_id,
            "subscription_id": data.get("id", ""),
            "seats": 1,
            "status": data.get("status", "active"),
            "updated_at": occurred_at,
        })
        team["status"] = data.get("status", "active")
        team["updated_at"] = occurred_at

    elif event_type == "subscription.updated":
        team = teams.setdefault(team_id, {
            "team_id": team_id,
            "subscription_id": data.get("id", ""),
            "seats": 1,
            "status": data.get("status", ""),
            "updated_at": occurred_at,
        })
        items = data.get("items") or []
        seats = items[0].get("quantity", team["seats"]) if items else team["seats"]
        team["seats"] = seats
        team["status"] = data.get("status", team.get("status", ""))
        team["updated_at"] = occurred_at

    return {"received": True}


@app.get("/teams/{team_id}")
def get_team(team_id: str) -> dict:
    team = teams.get(team_id)
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    return team
