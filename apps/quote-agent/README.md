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
- **Duplicate deliveries are ignored.** Gmail message ids and Slack event
  ids are deduplicated, and a double-clicked Approve button sends one quote,
  not two.
- **Writes are checked.** HubSpot deals are read back after every write. A
  Slack `ok:false` response fails the step, even though Slack returns
  HTTP 200 for it. A failed run alerts the manager channel.
- Discounts are always taken off the list subtotal. A 25% request on a quote
  that already has 5% off becomes 25%, not 30%.
- Only Slack users listed in `SLACK_MANAGER_USER_IDS` can approve or reject.
  The referenced quote must belong to the sender's own email address.

## Layout

| File | What it does |
|---|---|
| `quote_agent/orchestrator.py` | The workflow: routing, steps, pause/resume |
| `quote_agent/policy.py` | Discount thresholds |
| `quote_agent/classifier.py` | Claude intent + field extraction, rule-based fallback |
| `quote_agent/pricing.py` | Pricing service (catalog, volume tiers), also served at `POST /pricing/quote` |
| `quote_agent/providers/` | HubSpot, Slack, Gmail API clients |
| `quote_agent/app.py` | Webhooks and inspection endpoints |
| `quote_agent/store.py` | SQLite: runs, quotes, approvals, dedupe |

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env   # fill it in
uvicorn main:app --port 8000
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

## Tests

```bash
pip install -r requirements-dev.txt
pytest -q
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

## Not done yet

- No message to the customer while a discount waits on a manager, and no
  message when a >70% request is declined. Both are easy to add if you want
  them.
- Approvals never expire.
- Quotes are emailed as plain text. There's no PDF and no HubSpot Quote
  object, because the Quotes API needs a template set up in the HubSpot
  portal.
- Single process with SQLite. Use a real queue and database before running
  more than one instance.
