# Nimbus SaaS

Subscription lifecycle service for Nimbus SaaS. Handles Paddle webhook
events to track subscription state and gate feature access.

## Surface

| Endpoint | Purpose |
|---|---|
| `POST /webhook` | Receive Paddle subscription events |
| `GET /subscriptions/{id}` | Subscription detail + entitlement check |

## Stack

- FastAPI, Pydantic
- In-memory `subscriptions` dict (Postgres in prod)
- Webhook events: `subscription.created`, `subscription.activated`, `subscription.canceled`

## How to investigate / validate / debug

```
./fetchsandbox <your question or bug report>
```

Examples:
- `./fetchsandbox investigate this integration and fix anything wrong — with proof.`
- `./fetchsandbox why is my subscription never activating?`

## Run locally

```
pip install -r requirements.txt
uvicorn main:app --reload
```
