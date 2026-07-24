# Apex Recover

Dunning and payment recovery service for Apex. Tracks failed payments,
manages access revocation, and restores accounts on recovery.

## Surface

| Endpoint | Purpose |
|---|---|
| `POST /webhook` | Receive Paddle subscription and transaction events |
| `GET /accounts/{id}` | Account standing and access status |

## Stack

- FastAPI, Pydantic
- In-memory `accounts` dict (Postgres in prod)
- Webhook events: `subscription.created`, `subscription.activated`, `transaction.payment_failed`

## How to investigate / validate / debug

```
./fetchsandbox <your question or bug report>
```

## Run locally

```
pip install -r requirements.txt
uvicorn main:app --reload
```
