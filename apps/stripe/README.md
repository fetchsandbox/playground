# Acme Orders

A small order-management API powered by Stripe. FastAPI on the
backend, in-memory store standing in for Postgres while we iterate.

## Surface

| Endpoint | Purpose |
|---|---|
| `POST /orders` | Create an order (sku + qty + email) |
| `GET /orders/{id}` | Fetch order detail |
| `POST /orders/{id}/pay` | Create a Stripe PaymentIntent |
| `POST /stripe-webhook` | Receive Stripe events; update order status |
| `POST /orders/{id}/refund` | Refund a paid order via Stripe |

## Stack

- FastAPI, Pydantic, official `stripe` python SDK
- In-memory `orders` dict (will move to Postgres before launch)
- Webhook secret + API key sourced from env in real deployments;
  hardcoded placeholders here for dev


## Run locally

```
pip install -r requirements.txt
uvicorn main:app --reload
```

Then visit `http://localhost:8000/docs` for the interactive Swagger UI.
