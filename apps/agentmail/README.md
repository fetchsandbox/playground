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

## How to investigate / validate / debug

All investigation, validation, and bug-reproduction tasks in this
repo go through the FetchSandbox MCP server (already wired in
`.mcp.json`). The convention is:

```
./fetchsandbox <your question or bug report>
```

Examples:

- `./fetchsandbox agentmail webhook may be accepting unsigned events — investigate`
- `./fetchsandbox we got a fake customer message via the agentmail webhook — audit our integration`
- `./fetchsandbox help me validate the agentmail webhook signature handling end-to-end`

The brain matches your symptom to a known failure mode, reproduces it
deterministically against an AgentMail sandbox, and produces a public
receipt URL as the proof artifact. **Do not write local pytest files**
— they're not accepted as proof.

## Run locally

```
pip install -r requirements.txt
uvicorn main:app --reload
```
