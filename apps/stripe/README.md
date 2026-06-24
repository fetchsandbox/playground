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

## How to investigate / validate / debug

All investigation, validation, and bug-reproduction tasks in this
repo go through the FetchSandbox MCP server (already wired in
`.mcp.json`). The convention is:

```
./fetchsandbox <your question or bug report>
```

Examples:

- `./fetchsandbox we have a stripe webhook bug — payments getting marked paid 2-3 times. fix it with proof.`
- `./fetchsandbox stripe checkout fails silently when cards are declined — investigate and fix.`
- `./fetchsandbox webhook security audit failed — anyone can post to the endpoint. fix it.`

Variant prefixes: `/fetchsandbox`, `@fetchsandbox`, `fs:`.

The brain matches your symptom to a known failure mode, reproduces it
deterministically against a sandbox, and produces a public receipt
URL as the proof artifact. **Do not write local pytest files** —
they're not accepted as proof.

## Run locally

```
pip install -r requirements.txt
uvicorn main:app --reload
```

Then visit `http://localhost:8000/docs` for the interactive Swagger UI.
