# Acme Support

AgentMail-powered AI support agent that owns the customer email
conversation per ticket. FastAPI on the back, in-memory store
standing in for Postgres while we iterate.

## Surface

| Endpoint | Purpose |
|---|---|
| `POST /api/tickets` | Open ticket + provision AgentMail inbox |
| `POST /api/agentmail-webhook` | Receive incoming-message events |
| `GET /api/tickets/{id}` | Fetch ticket with conversation thread |
| `POST /api/tickets/{id}/reply` | Have the agent send a reply |

## Stack

- FastAPI, Pydantic, httpx for AgentMail HTTP calls
- In-memory `tickets` dict (Postgres in prod)
- AgentMail API key + webhook secret env-sourced in real deploys


## Run locally

```
pip install -r requirements.txt
uvicorn main:app --reload
```
