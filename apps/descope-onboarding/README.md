# Acme Notes — greenfield Descope onboarding

A tiny notes backend with a **placeholder login** — no real auth yet. The task is to add
**Descope OTP sign-up and a validated session** to it.

## Surface (today — insecure placeholder)

| Endpoint | Purpose |
|---|---|
| `POST /signup` | Placeholder: trusts the email, returns a fake token |
| `GET /notes` | List notes for the (insecurely) identified user |
| `POST /notes` | Add a note |

## Stack

- FastAPI, Pydantic
- Descope OTP + session: **not wired yet** — that's the task


## Run locally

```
pip install -r requirements.txt
uvicorn main:app --reload
```
