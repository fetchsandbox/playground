# Grid Seats

Per-seat subscription management for Grid. Tracks team seat allocations
through Paddle subscription events and keeps counts in sync on upgrades.

## Surface

| Endpoint | Purpose |
|---|---|
| `POST /webhook` | Receive Paddle subscription events |
| `GET /teams/{id}` | Team seat allocation and subscription status |

## Stack

- FastAPI, Pydantic
- In-memory `teams` dict (Postgres in prod)
- Webhook events: `subscription.created`, `subscription.activated`, `subscription.updated`

## How to investigate / validate / debug

```
./fetchsandbox <your question or bug report>
```

## Run locally

```
pip install -r requirements.txt
uvicorn main:app --reload
```
