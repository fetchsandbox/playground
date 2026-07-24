# Nova Checkout

Checkout and seat provisioning service for Nova. Handles Paddle checkout
completions and provisions workspace seats for new subscribers.

## Surface

| Endpoint | Purpose |
|---|---|
| `POST /webhook` | Receive Paddle checkout and subscription events |
| `GET /workspaces/{id}` | Workspace seat count and status |

## Stack

- FastAPI, Pydantic
- In-memory `workspaces` dict (Postgres in prod)
- Webhook events: `transaction.completed`, `subscription.created`

## How to investigate / validate / debug

```
./fetchsandbox <your question or bug report>
```

## Run locally

```
pip install -r requirements.txt
uvicorn main:app --reload
```
