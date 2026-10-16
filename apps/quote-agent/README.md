# Quote agent

Reads customer messages from **Gmail** and **Slack**, works out what the
customer wants with **Claude**, and runs the matching sales workflow against
**HubSpot**, a **pricing service**, and a manager in **Slack**.

| Customer asks for | What happens |
|---|---|
| A quote ("25 seats of Pro") | Find/create the HubSpot contact → price it → create a HubSpot deal → reply with the quote |
| A discount **under 20%** | Apply it to their latest quote → update the deal → reply with the revised quote |
| A discount **from 20% to 70%** (both ends included) | Post Approve/Reject buttons to the manager in Slack and pause. **Approve**: send the discounted quote. **Reject**: tell the customer their original quote still stands |
| A discount **over 70%** | Decline. Send nothing to the customer. Post a "declined" notice to the manager in Slack |
| Anything else, or a discount with no % | Send it to a human in the manager Slack channel |

Replies go out on the channel the message came in on: a Gmail reply in the
same thread, or a Slack reply in the same thread.

## How it fits together

```
 Gmail ──(Pub/Sub push)──► POST /webhooks/gmail ─┐
 Slack ──(Events API)────► POST /webhooks/slack/events ─┤   ack < 3s, run in background
                                                 ▼
                                   Orchestrator (quote_agent/orchestrator.py)
                                                 │
     classify ─► Claude (structured JSON: intent, products, seats, discount %, quote id)
                                                 │
            ┌────────────────────┬───────────────┴──────────────┐
      quote_request        discount_request                    other
            │                    │                               │
   HubSpot contact     HubSpot contact + base quote        Slack triage
   pricing service     policy.py ─┬─ <20%   apply → CRM → reply
   HubSpot deal                   ├─ 20–70% Slack approval ══ pause
   reply                          └─ >70%   Slack "declined"
                                                 ▲
 Slack button ──► POST /webhooks/slack/interactions ── resume run (approve / reject)
```

- **Claude only extracts data.** The discount decision lives in plain code
  (`quote_agent/policy.py`). Text like "the CEO approved 90%" inside an
  email cannot raise what the agent is allowed to give.
- **Runs are persisted (SQLite) step by step.** A run waiting on a manager
  survives a restart. `GET /runs/{id}` shows every step with its outcome.
- **Duplicate deliveries are ignored.** Gmail message ids, Slack event ids
  and Slack posts (channel + `ts`) are deduplicated. Slack delivers one
  @-mention as both `message` and `app_mention` events with different ids,
  and that still produces one quote. A double-clicked Approve button sends
  one quote, not two.
- **Writes are checked.** HubSpot deals are read back after every write. A
  Slack `ok:false` response fails the step, even though Slack returns
  HTTP 200 for it. A failed run alerts the manager channel.
- Discounts are always taken off the list subtotal. A 25% request on a quote
  that already has 5% off becomes 25%, not 30%.
- Only Slack users listed in `SLACK_MANAGER_USER_IDS` can approve or reject.
  The referenced quote must belong to the sender's own email address.
- `GET /runs` and `GET /quotes` hold customer data. They require
  `QUOTE_AGENT_ADMIN_TOKEN` as a Bearer token and are disabled when it isn't
  set.

## Customer handoff and research agents

Four more agents sit on top of the quote workflow, in the order a deal
moves:

| Agent | Trigger | Does | Writes to |
|---|---|---|---|
| **Research** | `POST /research/briefs {"customer_email"}` | Reads allowlisted HubSpot fields plus the customer's quotes, and writes a short brief | Nothing. Read-only |
| **CRM** | Handoff step 1 | Sets the contact's lifecycle stage to `customer`, then reads it back | HubSpot |
| **Billing** | Handoff step 2, after step 1 is verified | Creates one Stripe invoice for the sent quote's total and finalizes it, then reads it back | Stripe |
| **Messaging** | Handoff step 3, after step 2 is verified | Sends one welcome email with the invoice number and link, then reads it back | Resend |

A handoff starts when a deal is won:
`POST /handoff/runs {"quote_id": "Q-..."}` with `Authorization: Bearer
$HANDOFF_API_TOKEN`. A CRM automation or an external agent makes the same
call.

```
 quote agent ── sent quote Q-… ──► POST /handoff/runs
                                         │
   crm_lifecycle ──verify──► billing_invoice ──verify──► welcome_email ──verify──► completed
   (CRM agent, HubSpot)     (billing agent, Stripe)     (messaging agent, Resend)
        │ fails                  │ fails                     │ response lost
        ▼                        ▼                           ▼
   run failed: nothing      run failed: no email;       uncertain → repeat with the same
   billed, nothing sent     retry reuses the draft      Idempotency-Key → one email → verified
```

**Rules**

- **Each step waits for the one before it to be verified by reading the
  provider back.** There's no invoice unless HubSpot shows the contact as a
  customer, and no welcome email unless the invoice exists and matches the
  quote.
- **Only the sent quote can be handed off, and only once.** A quote waiting
  on discount approval, superseded by a revision, or never sent is refused
  with 409. A repeated or concurrent start returns the same run. The
  invoice amount is the sent quote's total, so an approved discount is
  what gets billed.
- **A lost response is uncertain, not failed, and is never retried
  blindly.** Every agent's action is safe to repeat:
  - CRM reads the stage before it writes.
  - Billing looks up the customer and this run's invoice before creating
    them, so it doesn't depend on Stripe idempotency keys alone.
  - Messaging resends with the same `Idempotency-Key`, which Resend
    answers with the original email.

  The action log keeps the whole `uncertain → reconciling → verified`
  sequence.
- **Pause** (`/handoff/runs/{id}/pause`) stops new steps. It doesn't undo
  a step that already ran. **Retry** re-queues a failed step after its cause
  is fixed. **Verify** resolves an uncertain step on demand.
- **Contain** (`POST /agents/{agent}/contain`) is the per-agent stop
  button. That agent's next action is blocked, and a step of that agent
  that's running at that moment is marked uncertain rather than assumed
  undone. `release` lifts it.
- **Every agent action goes through one gateway** (`handoff/gateway.py`).
  - Each agent's manifest names its owner, the actions it may take, the
    systems it touches, and the credential it uses. An action outside the
    manifest is blocked.
  - `GET /agents` serves the manifests, so an external control plane can
    discover the agents. That gateway is where it would take over the
    allow/hold/block decision.
  - `GET /actions` is the append-only action log (export). Each entry
    carries a hash of the exact payload.
- **The research agent is read-only by construction.** Its HubSpot client
  refuses any write. Only `RESEARCH_ALLOWED_FIELDS` are read, and only those
  fields go to Claude. The email address doesn't. Each brief lists the
  fields it shared.
- **Each agent has its own credential**: `HANDOFF_HUBSPOT_TOKEN`,
  `STRIPE_SECRET_KEY`, `RESEND_API_KEY` and `RESEARCH_HUBSPOT_TOKEN`.
  Handoff steps are `handoff_advance` jobs routed by agent, so with
  `AGENT_QUEUE_URLS` each agent can run as its own worker service with only
  its own secret.

Stripe is told not to finalize or email the invoice itself
(`auto_advance=false`). The welcome email is the only thing that reaches
the customer, and it goes out once.

## Layout

| File | What it does |
|---|---|
| `quote_agent/orchestrator.py` | The workflow: routing, steps, pause/resume |
| `quote_agent/policy.py` | Discount thresholds |
| `quote_agent/classifier.py` | Claude intent + field extraction, rule-based fallback |
| `quote_agent/pricing.py` | Pricing service (catalog, volume tiers), also served at `POST /pricing/quote` |
| `quote_agent/providers/` | HubSpot, Slack, Gmail, Stripe, Resend API clients |
| `quote_agent/handoff/workflow.py` | Customer handoff: step order, verify gates, uncertain/pause/retry/contain |
| `quote_agent/handoff/agents.py` | CRM, billing and messaging agents (act + verify) |
| `quote_agent/handoff/gateway.py` | Agent manifests, allowlist, containment, append-only action log |
| `quote_agent/handoff/research.py` | Read-only research agent |
| `quote_agent/handoff/api.py` | `/handoff`, `/agents`, `/actions`, `/research` routes |
| `quote_agent/app.py` | Webhooks (verify, enqueue, acknowledge), health, inspection endpoints |
| `quote_agent/jobs.py` | Job queue (SQS or in-process) and the jobs the worker runs |
| `quote_agent/worker.py` | SQS consumer |
| `quote_agent/__main__.py` | Process roles: `api`, `worker`, `migrate`, `gmail-watch`, `reap-stale-runs` |
| `quote_agent/store.py`, `db.py`, `migrations/` | PostgreSQL (SQLite locally): runs, quotes, approvals, dedupe; versioned migrations |
| `Dockerfile`, `docker-compose.yml` | Container image; local stack with Postgres and an SQS-compatible queue |
| `infra/terraform/` | AWS infrastructure |

## Setup

Run locally with SQLite and in-process jobs:

```bash
pip install -r requirements.txt
cp .env.example .env   # fill it in
uvicorn main:app --port 8000
```

Or run the production shape locally (PostgreSQL, SQS-compatible queue, separate worker):

```bash
docker compose up --build
```

**Claude.** Set `ANTHROPIC_API_KEY`. The default model is `claude-opus-5-5` at
low effort, with the server-side refusal fallback turned on. Without a key
(or with `CLASSIFIER=rules`), a regex classifier is used instead. That's
fine for local testing but not for real customer mail.

**HubSpot.** Create a private app with the `crm.objects.contacts.read/write`
and `crm.objects.deals.read/write` scopes. Put its token in
`HUBSPOT_ACCESS_TOKEN`. Each quote becomes a deal in `HUBSPOT_PIPELINE` /
`HUBSPOT_DEAL_STAGE`, and a revised quote updates the amount on the same
deal.

**Slack.** Create an app with:
- Bot scopes: `chat:write`, `users:read`, `users:read.email`, `im:history`,
  `app_mentions:read`, and `channels:history` if you use intake channels.
- Event Subscriptions → `https://<host>/webhooks/slack/events`, subscribed
  to `message.im` and `app_mention` (plus `message.channels` for intake
  channels).
- Interactivity → `https://<host>/webhooks/slack/interactions`.

Invite the bot to `SLACK_MANAGER_CHANNEL`.

**Gmail.** Create OAuth credentials with the `gmail.modify` scope and set
`GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN`. Then:
1. Create a Pub/Sub topic. Grant `gmail-api-push@system.gserviceaccount.com`
   publish rights on it.
2. Add a push subscription to
   `https://<host>/webhooks/gmail?token=<GMAIL_PUSH_TOKEN>`.
3. Call `users.watch` with the topic name. A watch expires after 7 days, so
   re-run it daily from a cron job.

### Try it without any accounts

```bash
DEV_ENDPOINTS=true CLASSIFIER=rules uvicorn main:app
```

`POST /dev/inbound` runs one message through the workflow synchronously.
`POST /dev/approvals/{id}/approved` stands in for the Slack button. Steps
for providers you haven't configured are skipped or fail, and each one is
visible in the run.

## Deploying to AWS

### Architecture

```
            Slack / Gmail Pub/Sub (HTTPS)
                        │
                 WAF ── ALB (TLS 1.3, public subnets; only /webhooks/* and /health routed)
                        │
          ┌─────────────┴─────────────┐   private subnets, 2 AZs
          │  ECS Fargate: api (×2+)   │  verify signature → enqueue → 200 in < 3 s
          └─────────────┬─────────────┘
                        │ SQS jobs queue ──(5 failures)──► DLQ ──► alarm
          ┌─────────────┴─────────────┐
          │  ECS Fargate: worker (1–6)│  scales on queue depth; runs the workflow
          └──────┬──────────────┬─────┘
                 │              │ NAT → Claude, HubSpot, Slack, Gmail
       RDS PostgreSQL 16        │
       (Multi-AZ, encrypted,    Secrets Manager: provider credentials (app secret),
        password managed by RDS)                 DB password (RDS-managed secret)

 EventBridge Scheduler → ECS task: reap-stale-runs (5 min), gmail-watch (daily)
 CloudWatch: JSON logs, error metric, alarms → SNS (DLQ, backlog age, 5xx, unhealthy, DB)
```

Details:

- **Durable webhooks.** Webhooks are verified, written to SQS and
  acknowledged. If a worker dies, the job returns to the queue, and after 5
  failed attempts it lands in the DLQ and raises an alarm. Jobs are safe to
  repeat: inbound messages are claimed in Postgres before any side effect,
  and approvals change state with one atomic update.
- **Interrupted runs are never retried blindly.** A run left `running` by a
  dead worker is marked failed by the `reap-stale-runs` schedule, and the
  manager is alerted in Slack. The customer may already have received
  something, so a human decides what happens next.
- **Migrations run on deploy.** Each api and worker task runs `migrate` as
  an init container under a Postgres advisory lock. Migrations must be
  backward compatible with the release still running: add columns and
  tables first, and remove old ones in a later release.
- **Fails fast on bad config.** The app refuses to start in staging or
  production without Postgres and SQS. In production it also refuses
  without a Claude key, or with dev or test hooks enabled.
- **Least privilege.**
  - Security groups: tasks accept traffic only from the ALB, and the
    database only from tasks.
  - IAM: the api role can only send to the queue, and the worker role can
    only consume it.
  - Containers: non-root user, read-only root filesystem.
  - ECR: images are scanned on push, and tags are immutable.
- **Admin API is not exposed by default.** `/runs` and `/quotes` are
  reachable only from `admin_cidr_blocks` through the ALB, and always need
  `QUOTE_AGENT_ADMIN_TOKEN`.

### First deploy

You need an AWS account, a domain with an ACM certificate in the target
region, and Terraform 1.6 or later.

1. **State backend.** Create an S3 bucket (versioned) and a DynamoDB lock
   table. Copy `infra/terraform/backend.hcl.example` to `backend.hcl` and
   fill it in.
2. **Variables.** Copy `infra/terraform/envs/example.tfvars` to
   `envs/staging.tfvars` and fill it in. It holds settings only; secrets go
   in step 4.
3. **Registry first, then build and push the image:**
   ```bash
   cd infra/terraform
   terraform init -backend-config=backend.hcl
   terraform apply -var-file=envs/staging.tfvars -target=aws_ecr_repository.app
   aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
   docker build -t <ecr_repository_url>:$(git rev-parse HEAD) ../.. && docker push <ecr_repository_url>:$(git rev-parse HEAD)
   ```
4. **Apply everything, then populate the app secret.** Every key in
   `app_secret_keys` must be present. Use an empty string for a provider you
   don't use. Then restart the services:
   ```bash
   terraform apply -var-file=envs/staging.tfvars -var image_tag=$(git rev-parse HEAD)
   aws secretsmanager put-secret-value --secret-id "$(terraform output -raw app_secret_arn)" \
     --secret-string file://secrets.json   # {"ANTHROPIC_API_KEY": "...", "SLACK_BOT_TOKEN": "...", ...}
   aws ecs update-service --cluster quote-agent-staging --service api --force-new-deployment
   aws ecs update-service --cluster quote-agent-staging --service worker --force-new-deployment
   ```
5. **DNS and provider URLs.** Point your domain at the `load_balancer_dns`
   output. Then set the Slack Events and Interactivity URLs and the Gmail
   Pub/Sub push endpoint to the `webhook_paths` on your domain.

### Continuous deployment

`.github/workflows/quote-agent.yml` runs on every change:
- the tests on SQLite and on PostgreSQL
- `terraform fmt` and `terraform validate`
- an image build

It also deploys, but only once the repository is configured for it:
1. Set the repository variables `AWS_DEPLOY_ROLE_ARN` (an IAM role trusted
   for GitHub OIDC, so no AWS keys are stored in GitHub), `AWS_REGION`,
   `TF_STATE_BUCKET` and `TF_LOCK_TABLE`.
2. Commit `envs/<environment>.tfvars`.

Pushes to `main` then deploy to staging. Production is a manual
`workflow_dispatch`: protect the `production` GitHub environment with
required reviewers.

A deploy pushes the image tagged with the commit SHA, then runs
`terraform apply -var image_tag=<sha>`. ECS rolls the services, and the
deployment circuit breaker rolls back automatically if new tasks fail
`/ready`.

### Runbook

| Situation | What to do |
|---|---|
| `dlq-not-empty` alarm | Read the failing job in the DLQ, and the worker logs with the same `request_id` (the SQS message id). Fix the cause, then use "Start DLQ redrive" in the SQS console. Replays are safe because jobs are idempotent. |
| `jobs-backlog-age` alarm | Workers are down or saturated. Check the worker service events and raise `worker_max_count` if needed. |
| Manager sees "run … was interrupted" | Look the run up with `GET /runs/{id}`. Check Slack or Gmail to see what the customer actually received, then follow up by hand. |
| Rotate a provider credential | `put-secret-value` with the new JSON, then force a new deployment of both services. |
| Roll back | Re-run the deploy with the previous commit SHA. The image tag is immutable. |

Rough monthly cost for staging (us-east-1, before traffic and data
transfer), about $250–300 in total:

| Item | Monthly |
|---|---|
| Five VPC interface endpoints across 2 AZs | ~$75 |
| Single-AZ db.t4g.medium RDS | ~$60 |
| Fargate: 2 api tasks + 1 worker | ~$55 |
| NAT gateway | ~$35 |
| ALB | ~$20 |
| WAF | ~$10 |

Production defaults (a NAT gateway per AZ, Multi-AZ database) add roughly
another $100. Use the AWS Pricing Calculator for your own numbers.

## Tests

Without `TEST_DATABASE_URL` the suite runs on SQLite. Set it to run the
whole suite on PostgreSQL, with a fresh schema per test.

```bash
pip install -r requirements-dev.txt
pytest -q
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/db pytest -q
```

The tests run the real HubSpot, Slack and Gmail client code against
in-memory fakes. They cover:
- every policy boundary (19.99 / 20 / 70 / 70.01)
- approve, reject, and approval by a non-manager
- double-clicks, redelivered Slack events and Gmail pushes
- bad Slack signatures
- prompt injection
- Slack `ok:false`
- the Claude structured-output call

The flow was also run against FetchSandbox's hosted HubSpot and Slack
sandboxes: quote, 5%, 25% with approval, and 80% declined. Messages and
contacts were read back from the sandboxes afterwards. The HubSpot sandbox
has no Deals API, so deal writes were only tested against the fakes. Gmail
has no sandbox and has not been run against the real API.

### Customer handoff verification

`tests/test_handoff.py` runs the real HubSpot, Stripe and Resend client code
against in-memory fakes. The Stripe fake, like the FetchSandbox Stripe twin,
ignores `Idempotency-Key`. The tests cover:
- the step order and the gate between steps
- lost responses on every Stripe and Resend write and on the HubSpot update
- repeated and concurrent starts
- pause, contain and retry
- the operator/agent token split and per-agent job routing
- the read-only research agent

FetchSandbox then drove the real app through its managed relay
(`verification/handoff_contract.py`, `application_workflow_v1`).
**20 of 21 checks held, none violated.** The one unmeasured check is the
accepted-response-loss check: this cloud container's egress proxy hides
the app's disconnect from the twin. The app's own log shows `uncertain →
reconciled → verified` with one email. Details and receipts are in
[`findings/2026-10-16-handoff-agents-fetchsandbox-relay.md`](../../findings/2026-10-16-handoff-agents-fetchsandbox-relay.md).
`verification/handoff_fetchsandbox.py` is the arm/probe harness used before
the relay run.

## External verification (FetchSandbox)

`verification/fetchsandbox_contract.py <session_id>` builds the
`application_workflow_v1` contract that FetchSandbox executed against this
app through its managed tunnel. The results are in
[`findings/2026-10-15-quote-agent-fetchsandbox.md`](../../findings/2026-10-15-quote-agent-fetchsandbox.md).

The verification uses three test-only hooks, all off unless their env var
is set:
- `QUOTE_AGENT_VERIFIER_TOKEN` enables the read-only `/verifier` adapter
  (Bearer-protected).
- `QUOTE_AGENT_PROVIDER_HEADERS` adds a run-correlation header to every
  provider request.
- `DEV_ENDPOINTS` lets the verifier drive the workflow over plain HTTP.

## Not done yet

- No message to the customer while a discount waits on a manager, and no
  message when a >70% request is declined. Both are easy to add if you want
  them.
- Approvals never expire.
- Quotes are emailed as plain text. There's no PDF and no HubSpot Quote
  object, because the Quotes API needs a template set up in the HubSpot
  portal.
- `DB_SSLMODE=require` encrypts database traffic but does not verify the
  RDS certificate. Add the RDS CA bundle to the image and use `verify-full`
  if your policy requires it.
- Approval requests have no expiry or reminder.
- Handoff:
  - The Terraform still deploys one worker service. Running each agent as
    its own service, with only its own secret, needs one SQS queue and ECS
    service per agent plus `AGENT_QUEUE_URLS`. The code supports it; the
    infrastructure doesn't define it yet.
  - The handoff is started over its API, not by a HubSpot "deal won"
    webhook.
  - The invoice is one line for the quote total, not one line per quote
    line.
