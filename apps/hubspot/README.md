# Northwind CRM

Contact sync service. Sales works out of HubSpot; everything else reads
from our own store, and this service keeps the two in step.

## Surface

| Endpoint | Purpose |
|---|---|
| `POST /contacts` | Create a contact locally and push it to HubSpot |
| `GET /contacts/{id}` | Fetch one contact |
| `GET /contacts` | List all contacts |
| `POST /contacts/{id}/resync` | Push a single contact to HubSpot again |
| `POST /sync` | Push every unsynced contact |

## Stack

- FastAPI, Pydantic, `httpx` against the HubSpot CRM v3 API
- In-memory `contacts` dict (moves to Postgres before launch)
- Access token from `HUBSPOT_ACCESS_TOKEN`; placeholder here for dev

## Run

```bash
pip install -r requirements.txt
uvicorn main:app --reload
```
