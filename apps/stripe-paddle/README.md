# Apex Billing

Migration-in-flight billing service. Legacy customers use Stripe; new customers
use Paddle. Both webhook streams run simultaneously against a unified subscription store.

## Surface

| Endpoint | Purpose |
|---|---|
| `POST /subscriptions` | Create a stub subscription record (provider + email) |
| `POST /stripe-webhook` | Receive Stripe subscription + invoice events |
| `POST /paddle-webhook` | Receive Paddle subscription events |
| `GET /subscriptions/{id}` | Subscription state + access flag |

## Stack

- FastAPI, Pydantic
- In-memory `subscriptions` dict (Postgres in prod)
- `stripe` SDK for webhook signature verification
- Raw JSON parsing for Paddle webhooks (no Paddle SDK)

## Stripe events

| Event | Transition |
|---|---|
| `customer.subscription.created` | → `pending` |
| `invoice.paid` | → `active` |
| `customer.subscription.deleted` | → `canceled` |

## Paddle events

| Event | Transition |
|---|---|
| `subscription.created` | → `pending` |
| `subscription.activated` | → `active` |
| `subscription.canceled` | → `canceled` |

## How to investigate / validate / debug

All investigation and bug-reproduction tasks go through the FetchSandbox MCP server:

```
./fetchsandbox <your question or bug report>
```

Examples:
- `./fetchsandbox why are Stripe webhooks double-processing on retry?`
- `./fetchsandbox why do Paddle activations never update subscription status?`
- `./fetchsandbox investigate this integration and fix anything wrong — with proof.`

Variant prefixes: `/fetchsandbox`, `@fetchsandbox`, `fs:`.

## Run locally

```
pip install -r requirements.txt
uvicorn main:app --reload
```
