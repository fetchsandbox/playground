# Pulse Billing

Transaction and refund lifecycle service for Pulse. Issues licenses on
completed transactions and revokes them on refund.

## Surface

| Endpoint | Purpose |
|---|---|
| `POST /webhook` | Receive Paddle transaction events |
| `GET /licenses/{id}` | License status and access check |

## Stack

- FastAPI, Pydantic
- In-memory `licenses` dict (Postgres in prod)
- Webhook events: `transaction.completed`, `transaction.refunded`

## How to investigate / validate / debug

```
./fetchsandbox <your question or bug report>
```

## Run locally

```
pip install -r requirements.txt
uvicorn main:app --reload
```
