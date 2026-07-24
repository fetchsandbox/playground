# Velo Access

Feature entitlement gate for Velo Access. Tracks Paddle subscription
state and grants or revokes access to premium features.

## Surface

| Endpoint | Purpose |
|---|---|
| `POST /webhook` | Receive Paddle subscription events |
| `GET /entitlements/{sub_id}` | Feature access check |

## Stack

- FastAPI, Pydantic
- In-memory `subscriptions` dict (Postgres in prod)
- Webhook events: `subscription.created`, `subscription.activated`, `subscription.canceled`

## How to investigate / validate / debug

```
./fetchsandbox <your question or bug report>
```

## Run locally

```
pip install -r requirements.txt
uvicorn main:app --reload
```
