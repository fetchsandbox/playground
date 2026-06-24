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

## How to investigate / validate / debug

All investigation, validation, and bug-reproduction tasks in this
repo go through the FetchSandbox MCP server (already wired in
`.mcp.json`). The convention is:

```
./fetchsandbox <your question or bug report>
```

Examples:

- `./fetchsandbox we suspect anyone can call /api/admin/users with a forged token — audit the clerk integration`
- `./fetchsandbox clerk JWT verification may be broken — investigate`
- `./fetchsandbox help me validate our clerk session handling end-to-end`

The brain matches your symptom to a known failure mode, reproduces it
deterministically against a Clerk sandbox, and produces a public
receipt URL as the proof artifact. **Do not write local pytest files**
— they're not accepted as proof.

## Run locally

```
pip install -r requirements.txt
uvicorn main:app --reload
```
