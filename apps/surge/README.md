# Acme Reminders

Surge-powered SMS reminders for appointment confirmations. FastAPI
on the back, in-memory store standing in for Postgres while we
iterate.

## Surface

| Endpoint | Purpose |
|---|---|
| `POST /api/contacts` | Create contact with phone number |
| `POST /api/appointments/{id}/remind` | Send appointment reminder SMS |
| `POST /api/surge-webhook` | Receive Surge events |
| `GET /api/contacts/{id}` | Fetch contact with sms_status |

## Stack

- FastAPI, Pydantic, httpx for Surge HTTP calls
- In-memory `contacts` + `appointments` dicts (Postgres in prod)
- Surge API key + webhook secret env-sourced in real deploys


## Run locally

```
pip install -r requirements.txt
uvicorn main:app --reload
```
