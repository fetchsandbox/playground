# Acme Agent Gateway

Descope agentic-auth backend. AI agents authenticate with a Descope
**access key**, exchange it for a scoped session JWT, then call
operations gated by those scopes.

## Surface

| Endpoint | Purpose |
|---|---|
| `POST /api/agent/exchange` | Exchange a Descope access key for a scoped session |
| `GET /api/agent/whoami` | Return the agent identity + granted scopes |
| `POST /api/tenant/users` | Create a user — requires the `users:write` scope |

## Stack

- FastAPI, Pydantic, PyJWT
- Access-key → scope map env-sourced / mirrored from Descope in prod


## Run locally

```
pip install -r requirements.txt
uvicorn main:app --reload
```
