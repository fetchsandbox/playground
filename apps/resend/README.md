# Acme Notifications

Resend-powered transactional email for sign-ups + password resets.
FastAPI on the back, in-memory user store standing in for Postgres
while we iterate.

## Surface

| Endpoint | Purpose |
|---|---|
| `POST /signup` | Create user + send welcome email |
| `POST /password-reset` | Send password-reset email |
| `POST /resend-webhook` | Receive Resend events; update user state |
| `GET /users/{id}` | Fetch user with email_status |

## Stack

- FastAPI, Pydantic, official `resend` python SDK
- In-memory `users` dict (will move to Postgres before launch)
- API key + webhook secret sourced from env in real deployments


## Run locally

```
pip install -r requirements.txt
uvicorn main:app --reload
```
