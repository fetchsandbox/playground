# Customer Ops Multi-Agent Workflow

Slack-triggered **parallel agent** pipeline for quote → research → billing → AE handoff → survey.

Designed to run **locally** (FastAPI) and deploy to **AWS** (API Gateway + Lambda + Step Functions + DynamoDB) with explicit handling for **errors** (per-agent scopes) and **races** (idempotent claims + vendor idempotency keys).

## Agents

| Agent | Job | Systems |
|---|---|---|
| **Research** | Enrich company / segment / SKU recommendation | deterministic enrichment (swap Clearbit later) |
| **Quote** | Build priced quote (volume discount rules) | internal |
| **Billing** | Ensure Stripe customer + draft invoice | **Stripe** |
| **Handoff** | Upsert HubSpot contact/deal + AE Slack summary | **HubSpot**, **Slack** |
| **Survey** | Send CSAT email after handoff | **Gmail** |

```
Slack /customer-ops  ──►  Claim (DynamoDB lease)
                            │
                            ▼
                         Research
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
            Quote                      Billing
              │                           │
              └─────────────┬─────────────┘
                            ▼
                         Handoff  ──►  Survey  ──►  Finalize
```

Each Step Functions Task (and each local `run_with_scope`) **catches** failures so a Stripe blip does not erase a good HubSpot deal.

## Race / retry model

| Hazard | Mitigation |
|---|---|
| Slack retries the same `event_id` | `idempotency_key=slack:{event_id}` + conditional claim |
| Two workers start the same quote | DynamoDB / in-memory conditional `claim()` — losers get the winner’s record |
| Stripe double-charge / double invoice | `Idempotency-Key: {workflow_id}:stripe:invoice` (+ local bus cache) |
| HubSpot duplicate contacts | upsert-by-email + idempotent bus key |
| Optimistic lock lost while saving agent output | reload + merge agent result |
| Transient vendor errors | SFN Retry (3×, backoff) then Catch → soft-fail branch |

## Quick start (local)

```bash
cd customer-ops-workflow
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt

# One-shot demo (prints JSON fan-out)
PYTHONPATH=src python scripts/local_demo.py

# API (Slack-compatible routes)
PYTHONPATH=src uvicorn customer_ops.api:app --reload --port 8080

# Tests
PYTHONPATH=src pytest -q
```

### Trigger examples

```bash
# HTTP
curl -s localhost:8080/workflows -H 'content-type: application/json' -d '{
  "customer_email":"ada@acme.com",
  "customer_name":"Ada",
  "company":"Acme",
  "sku":"pro_annual",
  "quantity":3,
  "channel_id":"C01",
  "idempotency_key":"demo-1"
}' | jq .

# Slack slash text (local form post)
curl -s localhost:8080/slack/commands -d \
  'text=email=ada@acme.com%20company=Acme%20qty=3&channel_id=C01&user_id=U01&team_id=T01&trigger_id=t1'
```

Slack message format:

```
/customer-ops email=ada@acme.com name=Ada company=Acme sku=pro_annual qty=3
```

## AWS deploy

Prereqs: AWS credentials, Node 18+ (for `npx aws-cdk`), Docker (Lambda bundling).

```bash
cd customer-ops-workflow/infra
pip install -r requirements.txt
npx aws-cdk bootstrap   # once per account/region
npx aws-cdk synth
npx aws-cdk deploy
```

Outputs:

- `SlackEventsUrl` → Slack Event Subscriptions Request URL  
- `SlackCommandsUrl` → Slash command Request URL (`/customer-ops`)  
- `StateMachineArn` / `TableName`

### Slack app settings

1. Create a Slack app (Socket Mode optional — this stack uses **HTTP Events** via API Gateway).
2. Slash command `/customer-ops` → `SlackCommandsUrl`.
3. Event Subscriptions → `SlackEventsUrl` (bot events: `app_mention`).
4. Scopes: `chat:write`, `commands`, `app_mentions:read`.
5. Put secrets in Lambda env (or SSM): `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `STRIPE_API_KEY`, `HUBSPOT_ACCESS_TOKEN`, `GMAIL_ACCESS_TOKEN`, and set `CUSTOMER_OPS_USE_MOCKS=0`.

### Step Functions shape

Mirrors the local orchestrator:

1. **ResearchAgent** (Task + Retry + Catch)  
2. **Parallel** → QuoteAgent ‖ BillingAgent  
3. **HandoffAgent** → **SurveyAgent** → **Finalize**

## Layout

```
customer-ops-workflow/
  src/customer_ops/
    api.py                 # local FastAPI + Slack HTTP
    orchestrator.py        # parallel waves + claim
    models.py / store.py   # records + race-safe persistence
    agents/                # research quote billing handoff survey
    integrations/          # stripe hubspot gmail slack (mock|live)
    handlers/              # Lambda entrypoints for SFN / Slack
  infra/                   # AWS CDK stack
  tests/
  scripts/local_demo.py
```

## Env

See `.env.example`. Defaults use **mocks** (`CUSTOMER_OPS_USE_MOCKS=1`) so the workflow is fully exercisable without vendor keys.

## Notes

- Local mode keeps state in-process (fine for demos/tests). AWS mode uses DynamoDB.
- Quote ‖ Billing race: billing may price from SKU first; if quote later applies a discount, billing is re-invoked under the **same** Stripe idempotency key so the draft invoice is not duplicated.
- This is a playground-grade scaffold — tighten IAM, add DLQs, and wire real research vendors before production traffic.
