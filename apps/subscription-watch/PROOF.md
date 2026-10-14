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

## 6. FetchSandbox-driven verification over the managed tunnel (2026-10-14)

The local app ran on 127.0.0.1:8088 behind a FetchSandbox managed relay (`manage_tunnel`),
bound to fresh twins in session `vs_633aa244f208`. FetchSandbox itself drove the
app over HTTP and read back saved state, so the app was not reporting on itself.
The drive and read-back went through the opt-in test adapter
(`subwatch/test_adapter.py`: inbox insert plus record read-back, verifier-token
protected) and the real `POST /run` entry point. Short-lived twin keys and the
verifier token came through `install_test_credentials` and were loaded from a
private dotenv file that was never printed. Preflight confirmed 200 with the
token and 401 without it.

Final attempt `vr_6c93a669248444cf94beb9aa2da80bb3`, receipt:
https://fetchsandbox.com/runs/06afbb1d62?flow=vr_6c93a669248444cf94beb9aa2da80bb3

| Check | Fault | Result |
|---|---|---|
| baseline: receipt → Slack + Calendar on 2026-11-10, $15.49 | – | **held** |
| ignore_personal_mail | – | **held** |
| rerun_no_duplicates: 1 email, 3 runs | – | **held** |
| concurrent_runs_single_effect: 4 overlapping `/run` | – | **held** |
| slack_429_reminder_still_created | slack rate_limited | **held** |
| slack_429_recovery | slack rate_limited → cleared | **held** |
| calendar_401_alert_still_posted | calendar auth_failure | **held** |
| gmail_429_outage_then_recovery: `/run` 502, then completes | gmail rate_limited → cleared | **held** |
| slack_channel_not_found_is_failure | slack channel_not_found | unmeasured: the fault is an HTTP 200 `ok:false`, so FetchSandbox records no refusal. App state was as asserted (failed, reminder created, no Slack ts). |
| slack_accepted_response_loss | – | unmeasured: typed **policy** blocker (see below) |
| restart_keeps_state | – | unmeasured: typed **setup** blocker (no runtime-identity observer or restart hook) |

FetchSandbox's overall verdict is **inconclusive**, because 3 checks are
unmeasured. It does not call the app verified.

**The earlier attempt** `vr_c6101c1c4ba140d39a5cda1402247a98` reported
`rerun_no_duplicates` as **violated** ("1 → 3"). That was a contract error on my
side: `repeat: 3` replays the whole action list, including the email insert, so
three *distinct* emails were inserted, and three records is correct. The check
was corrected to insert once and then run three times. The failed attempt stays
in the session history.

**Provider-side reconciliation after both attempts:** 14 Calendar events, 14
distinct ids, one per subscription email. Slack had **20** alerts against **13**
recorded Slack posts. The 7 extra come from my harness wiping the app's SQLite
state between attempts while the Gmail twin kept attempt 1's emails, so attempt
2 re-alerted them. Calendar absorbed the replay through deterministic event ids,
but Slack can't. **If the state store is lost, Slack alerts repeat.** In
production DynamoDB (with point-in-time recovery) holds this state. If duplicate
alerts after a state loss matter, the fix is a Slack-side dedupe: search channel
history for the Gmail id before posting (needs `channels:history`). That's the
same owner decision as the open `slack_accepted_response_loss` policy.

### 6b. Re-run after FetchSandbox server changes (2026-10-14, later)

The same app commit (`215eb80`), the same frozen 11-check contract and the same
tunnel flow ran against fresh twins in session `vs_afc34933e5e4`. It was a single
attempt, `vr_52799f2d4ade4aceb13ee73c3c5b9f6c`. Receipt:
https://fetchsandbox.com/runs/8aff5ed78c?flow=vr_52799f2d4ade4aceb13ee73c3c5b9f6c

- **9/9 executable checks held.** That's the 8 from the morning run plus
  `slack_channel_not_found_is_failure`, which was unmeasured before. FetchSandbox
  now records Slack's HTTP 200 `ok:false` fault as observed.
- The 2 typed blockers are unchanged (`slack_accepted_response_loss` policy,
  `restart_keeps_state` setup). The verdict is still **inconclusive**, not verified.
- **Provider-side reconciliation:** 5 Slack alerts and 6 Calendar events for 6
  subscription emails. Every Slack `ts` and Calendar id matches an app record. No
  duplicates. App state was not wiped mid-session this time.

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
