# Orion Plans

Plan upgrade and downgrade service for Orion. Tracks Paddle subscription
changes and keeps the local plan record in sync.

## Surface

| Endpoint | Purpose |
|---|---|
| `POST /webhook` | Receive Paddle subscription events |
| `GET /subscriptions/{id}` | Current plan and subscription status |

## Stack

- FastAPI, Pydantic
- In-memory `subscriptions` dict (Postgres in prod)
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
