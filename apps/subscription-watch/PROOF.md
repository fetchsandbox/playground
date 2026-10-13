# Proof: what was run, what was observed

Date: 2026-10-13 (UTC). The real app (`uvicorn app:app`, unchanged code, SQLite
state) ran against three isolated FetchSandbox API twins: Gmail, Google
Calendar and Slack. The app's provider base URLs pointed at the twins, and the
paths, payloads and auth were the vendors' own. FetchSandbox validation session
`vs_ed3c4551bfb1`. Twin sandboxes: Gmail `be0a525888`, Calendar `8a0cf8a9f7`,
Slack `b39031c700`.

Every outcome below was checked on the **provider side**: Slack via
`conversations.history`, Calendar via the twin's stored event state. It was not
taken only from the app's own report.

## 1. Happy path, triggered by a Gmail push

Two emails were inserted into the inbox: a Disney+ subscription receipt and
"Lunch thursday?". A Pub/Sub-shaped push hit `POST /gmail/push?token=…`.

| Email | App record | Slack `#billing` | Calendar |
|---|---|---|---|
| Netflix receipt, "Next billing date: November 13, 2026" | completed | 1 alert, $15.49, renews 2026-11-13 | "Cancel Netflix subscription?" on **2026-11-10** |
| Disney+ receipt, "renews on November 20, 2026" | completed | 1 alert, $13.99 | "Cancel Disney+ subscription?" on **2026-11-17** |
| Lunch thursday? | ignored | nothing | nothing |
| 3 twin placeholder messages (no RFC 822 body) | unparsable | nothing | nothing |

The push round trip (list, fetch 6 messages, 2 Slack posts, 2 events) took about 7 s
against the remote twins. A push with a wrong token got **403** and did nothing.

## 2. Rerun: no duplicates

A second `POST /run` returned `already_done: 6, completed: []`. Slack still
had 2 alerts and Calendar still had 2 app events.

## 3. Failure probes (FetchSandbox fault injection, correlated by `X-Flow-Run-Id`)

| Probe | Provider answer | App behaviour (checked in app state + provider state) | Next clean run |
|---|---|---|---|
| `slack:channel_not_found` | HTTP **200** `ok:false` | Recorded `failed` with `channel_not_found` and no Slack ts. **Calendar reminder still created.** | Slack posted once. Calendar event id unchanged (not re-created). |
| `google-calendar:auth_failure` | HTTP 401 | Slack alert posted. Calendar recorded `failed`, non-retryable. | Calendar created. Slack **not** re-posted. |
| `gmail:rate_limited` | HTTP 429 | Exactly **2** correlated requests (call + one `Retry-After` retry), then the run stopped with 502. Nothing marked done. | Picked up normally. |
| `slack:rate_limited` | HTTP 429, `Retry-After: 30` | 30 s is over the 20 s cap, so no in-run retry. Recorded `failed` (retryable). **Reminder still created.** | Slack posted once. |

FetchSandbox reports every probe as `inconclusive`, and that label is accurate
for what it measures. For the three HTTP-level faults it observed the correlated
refusal, but in this caller-executed mode it never verifies application state
itself. `channel_not_found` is an HTTP 200, so its traffic check has no refusal
to observe. The app-state outcomes in the table above come from reading the app's
`/processed` records and the providers' stored state directly.

The first `channel_not_found` attempt was also inconclusive, for a harness
reason: my test-email script called Gmail inside the armed window without the run
header. It was re-run with seeding moved before arming.

**Design change caused by a probe:** the first `channel_not_found` run showed that
a Slack failure also blocked the Calendar reminder. The two actions were made
independent (`processor.py`) and a test was added.

## 4. Final reconciliation (after 9 runs, 4 of them under faults)

- 5 subscription emails → **5** Slack alerts (1 each) and **5** Calendar events (1 each).
- Calendar total 10 = 3 twin seed events + 2 from manual API exploration before the app ran + 5 from the app.
- All 5 records `completed`. 1 `ignored`, 3 `unparsable`.

## 5. Offline checks

- `pytest -q`: **18 passed**. Rules and extraction, idempotency, partial failure
  and recovery, 409 handling, 429 retry, Gmail auth abort, and the Lambda handler
  against moto DynamoDB and Secrets Manager (scheduled sweep, push token check, 404).
- `cfn-lint template.yaml`: clean.

## Not verified

- **Real Gmail, Calendar and Slack accounts.** Everything above ran against API
  twins. The first run against your real accounts is still the real test.
- **Twin fidelity gaps I hit:** the Gmail twin ignores `q` and `labelIds` filters and
  doesn't apply `messages.modify`. The Calendar twin 404s on `events.get` and
  doesn't enforce client-supplied event-id uniqueness (409). So the app's
  "409 means already created" path is unit-tested only. The app never relies on
  Gmail-side filtering or labels (rules and dedupe are its own), so these gaps
  don't hide a dependency.
- **AWS deploy.** I had no AWS credentials or SAM CLI here. The template lints
  clean and the handler is tested under moto, but nothing was deployed.
- **Google OAuth refresh and Gmail `users.watch` / Pub/Sub delivery.** The code path
  for the refresh token exists but was not exercised against Google.
- Reference run of Slack `post_message_to_channel` (FetchSandbox's own client,
  not this app): https://fetchsandbox.com/runs/032fdfc849
