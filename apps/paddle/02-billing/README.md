# Aterna Cloud

Usage-credit billing service for Aterna Cloud. Grants API credits when
Paddle transactions complete.

## Surface

| Endpoint | Purpose |
|---|---|
| `POST /webhook` | Receive Paddle transaction events |
| `GET /accounts/{id}` | Account credit balance and transaction history |

## Stack

- FastAPI, Pydantic
- In-memory `accounts` dict (Postgres in prod)
- Webhook events: `transaction.completed`


## Run locally

```
pip install -r requirements.txt
uvicorn main:app --reload
```
