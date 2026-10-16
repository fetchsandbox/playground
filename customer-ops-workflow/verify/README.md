# FetchSandbox verification

## Managed tunnel (preferred)

```bash
# API key from https://fetchsandbox.com (device auth → ~/.fetchsandbox/credentials.json)
export FETCHSANDBOX_API_KEY=…
node run-proof-receipt.mjs
```

Opens a managed tunnel to the local FastAPI app, creates Stripe / HubSpot /
Gmail / Slack twins, runs `application_workflow_v1` (happy path, provider
faults, unsigned webhook rejection), and writes a receipt URL to
`latest-receipt.txt`.

## Twin smoker (no tunnel)

With twin `*_BASE` / `*_KEY` env from a prior `validate_integration` handoff:

```bash
node twin-driver.mjs
```

## App routes used by the suite

| Method | Path | Role |
|---|---|---|
| POST | `/process-workflow` | Drive multi-agent workflow against twins |
| GET | `/runs/{run}/cases/{case}/workflows` | Observe `workflows[*]` |
| GET | `/runs/{run}/cases/{case}/webhooks` | Observe `webhooks[*]` |
| POST | `/webhooks/slack` | Strict Slack signing secret |
| POST | `/webhooks/stripe` | Stripe-Signature (or reject) |
