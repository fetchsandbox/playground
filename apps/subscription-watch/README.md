# subscription-watch

Gmail + Google Calendar + Slack workflow:

> When an email arrives that looks like a **subscription charge** (receipt,
> invoice, renewal notice), post an alert to **Slack** and add an all-day
> **Google Calendar** event reminding you to decide whether to cancel it, 3 days
> before it renews.

```
 Gmail ──push (Pub/Sub)──┐
                         ├─► run: list recent inbox ─► rules.json ─┬─► Slack chat.postMessage
 EventBridge (5 min) ────┘     skip already-done mail              └─► Calendar events.insert
                                     │
                                     └─ DynamoDB / SQLite: one record per Gmail message
```

What has been verified, and what hasn't, is in [PROOF.md](PROOF.md).

## How it behaves

| Situation | What happens |
|---|---|
| Subscription email arrives | One Slack alert + one Calendar event "Cancel <Vendor> subscription?" on *renewal date − 3 days* (or *received + 7 days* if no renewal date is stated). Never in the past. |
| Any other email | Recorded as `ignored`; nothing posted. |
| Same email seen again (rerun, duplicate push) | Skipped. Each action is saved as soon as it succeeds. |
| Slack fails (`ok:false`, 429, outage) | Calendar reminder is still created. Slack is retried on the next run, and the reminder is not re-created. |
| Calendar fails | Slack alert still posts. Calendar is retried next run and Slack is not re-posted. Event ids are deterministic per Gmail message, so a retried insert gets 409 instead of creating a duplicate. |
| 429 with `Retry-After` ≤ 20 s | Retried once after waiting. If the wait is longer, the call is deferred to the next run. |
| Gmail 401/403/429 | Run stops early. Nothing is marked done, so the next run picks everything up. |
| A message keeps failing | Gives up after 5 attempts (`status: gave_up`, error saved). |

Slack success is decided by the `ok` field in the body, never the HTTP status.
Slack answers most failures with HTTP 200.

## Rules

Edit [`rules.json`](rules.json). A rule matches when all declared conditions hold:

- `from_domains_any`: sender domain (optional, e.g. `["netflix.com", "spotify.com"]`)
- `subject_any`: phrase in subject
- `text_any`: phrase in subject or body
- `exclude_any`: none of these phrases

Matching is case-insensitive on word boundaries, so a newsletter's "unsubscribe"
footer does not count as "subscription". The vendor, amount and renewal date are
extracted automatically (e.g. "Next billing date: November 13, 2026",
"renews on 14 Oct 2026", "2026-11-25").

## Run locally

```sh
cd apps/subscription-watch
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q          # 18 tests, no network
cp .env.example .env                   # fill in, then:
set -a; source .env; set +a
.venv/bin/uvicorn app:app --port 8088
curl -X POST localhost:8088/run        # process inbox now
curl localhost:8088/processed          # what it did, per message
```

`scripts/insert_test_email.py` drops a test email into an inbox through Gmail
`messages.insert` (nothing is sent), so you can trigger the workflow on demand.

## Credentials

**Google** (one OAuth client covers Gmail and Calendar):
1. Google Cloud console: enable the Gmail API and Google Calendar API, and create an OAuth client (Desktop app).
2. Get a refresh token for your account with scopes
   `gmail.readonly` and `calendar.events` (add `gmail.insert` only if you want
   to use the test-email script against real Gmail). For example, use the
   [OAuth Playground](https://developers.google.com/oauthplayground) with your own client.
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`.

**Slack**: create an app, add the bot scope `chat:write`, install it to the
workspace, set `SLACK_BOT_TOKEN` (xoxb-…), and **invite the bot to the channel**
(`/invite @yourbot`). Otherwise Slack returns `not_in_channel`. Set
`SLACK_CHANNEL` to the channel ID.

## Deploy to AWS (SAM)

```sh
aws secretsmanager create-secret --name subwatch --secret-string '{
  "GOOGLE_CLIENT_ID":"...","GOOGLE_CLIENT_SECRET":"...","GOOGLE_REFRESH_TOKEN":"...",
  "SLACK_BOT_TOKEN":"xoxb-...","PUSH_TOKEN":"<long random string>"}'

sam build
sam deploy --guided   # SecretsArn=<arn above>, SlackChannel=C0123456789
```

This creates one Lambda (Python 3.12, concurrency 1), a DynamoDB table, an
EventBridge schedule (every 5 min) and a Function URL for Gmail push.

**Real-time (optional, recommended):** without push, the 5-minute sweep is the
latency. For near-instant alerts:
1. In Google Cloud, create a Pub/Sub topic and grant
   `gmail-api-push@system.gserviceaccount.com` *Publisher* on it.
2. Create a **push** subscription to `<PushEndpoint output>gmail/push?token=<PUSH_TOKEN>`.
3. Call Gmail `users.watch` with `{"topicName": "projects/<p>/topics/<t>", "labelIds": ["INBOX"]}`.
   A watch expires after 7 days, so renew it daily, for example with a second schedule.

The push only wakes the function. Each run re-reads the inbox, so a lost or
duplicated notification can't lose or double an alert.

## Files

| Path | What |
|---|---|
| `subwatch/processor.py` | the workflow |
| `subwatch/rules.py` + `rules.json` | matching and extraction |
| `subwatch/gmail.py`, `slack.py`, `gcal.py` | provider clients |
| `subwatch/store.py` | SQLite / DynamoDB state |
| `app.py` | local HTTP server |
| `lambda_handler.py`, `template.yaml` | AWS |
| `tests/` | unit + Lambda (moto) tests |
