# Acme HelpDesk

AI-powered support platform combining Clerk (human auth), Descope (agent auth), and AgentMail (email channel).

## How it fits together

| Layer | Service | Who uses it |
|---|---|---|
| Human auth | Clerk JWT | Customers opening / viewing tickets |
| Agent auth | Descope access key → session JWT | AI agents reading and replying |
| Email channel | AgentMail inboxes | Per-ticket inboxes; agents reply, customers receive |

## Endpoints

### Customer (Clerk JWT)
```
POST /api/customer/tickets          open a ticket
GET  /api/customer/tickets          list my tickets
GET  /api/customer/tickets/{id}     view ticket + thread
```

### Agent (Descope session JWT)
```
POST /api/agent/exchange            exchange access key for session JWT
GET  /api/agent/whoami              agent identity + scopes
GET  /api/agent/tickets             list open tickets  [tickets:read]
POST /api/agent/tickets/{id}/reply  send reply via AgentMail  [tickets:write]
PATCH /api/agent/tickets/{id}/status  mark resolved/open  [tickets:write]
```

### Webhooks
```
POST /api/webhooks/clerk            Clerk user.created / user.deleted
POST /api/webhooks/agentmail        AgentMail message.received
```

## Demo access keys

| Key | Agent | Scopes |
|---|---|---|
| `ak_readonly` | `reader-bot` | `tickets:read` |
| `ak_readwrite` | `resolver-bot` | `tickets:read`, `tickets:write` |

## Running locally

```bash
pip install -r requirements.txt
uvicorn main:app --reload
```
