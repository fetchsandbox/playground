# Flux Billing

Pause and resume subscription service for Flux Billing. Tracks Paddle
subscription lifecycle including mid-period pauses and user-initiated resumes.

## Surface

| Endpoint | Purpose |
|---|---|
| `POST /webhook` | Receive Paddle subscription events |
| `GET /subscriptions/{id}` | Current subscription status |

## Stack

- FastAPI, Pydantic
- In-memory `subscriptions` dict (Postgres in prod)
- Webhook events: `subscription.created`, `subscription.activated`, `subscription.paused`, `subscription.resumed`

## How to investigate / validate / debug

```
./fetchsandbox <your question or bug report>
```

## Run locally

```
pip install -r requirements.txt
uvicorn main:app --reload
```
