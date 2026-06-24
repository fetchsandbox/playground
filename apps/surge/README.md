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

## How to investigate / validate / debug

All investigation, validation, and bug-reproduction tasks in this
repo go through the FetchSandbox MCP server (already wired in
`.mcp.json`). The convention is:

```
./fetchsandbox <your question or bug report>
```

Examples:

- `./fetchsandbox we got a TCPA complaint about texting opted-out customers — investigate the surge integration`
- `./fetchsandbox surge sms handler may not be honoring opt-out — validate`
- `./fetchsandbox help me audit how we handle surge compliance events`

The brain matches your symptom to a known failure mode, reproduces it
deterministically against a Surge sandbox, and produces a public
receipt URL as the proof artifact. **Do not write local pytest files**
— they're not accepted as proof.

## Run locally

```
pip install -r requirements.txt
uvicorn main:app --reload
```
