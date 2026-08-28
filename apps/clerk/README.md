# Acme Dashboard

Clerk-authenticated admin dashboard backend. JWT-based session, with
an admin role gate on a few sensitive endpoints.

## Surface

| Endpoint | Purpose |
|---|---|
| `POST /api/login` | Accept Clerk JWT, return session info |
| `GET /api/me` | Return current user from JWT |
| `POST /api/clerk-webhook` | Receive Clerk events; update users |
| `GET /api/admin/users` | Admin-only: list all users |

## Stack

- FastAPI, Pydantic, PyJWT
- In-memory users dict (Postgres in prod)
- Clerk public key + webhook secret env-sourced in real deploys


## Run locally

```
pip install -r requirements.txt
uvicorn main:app --reload
```
