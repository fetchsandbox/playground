# Helix Trial

Trial-to-paid conversion service for Helix. Manages the subscription
lifecycle from free trial through activation and cancellation.

## Surface

| Endpoint | Purpose |
|---|---|
| `POST /webhook` | Receive Paddle subscription events |
| `GET /access/{sub_id}` | Trial or paid access check |

## Stack

- FastAPI, Pydantic
- In-memory `subscriptions` dict (Postgres in prod)
- Webhook events: `subscription.created`, `subscription.trialing`, `subscription.activated`, `subscription.canceled`

## How to investigate / validate / debug

```
./fetchsandbox <your question or bug report>
```

## Run locally

```
pip install -r requirements.txt
uvicorn main:app --reload
```
