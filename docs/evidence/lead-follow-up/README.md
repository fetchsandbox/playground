# Lead follow-up — verification record

Sanitized evidence for the [lead follow-up workflow](../../workflows/lead-follow-up.md)
(`acme-ops/src/workflows/lead-follow-up.ts`). Synthetic `example.test` leads on
isolated FetchSandbox twins only: no live HubSpot, Gmail, Calendar or Slack
account was used, no real email was sent and no real customer record was created.

## Contract (agreed before implementation)

Discovered with the FetchSandbox MCP (`validate_integration` session
`vs_aaff1efcaa39`): HubSpot, Gmail, Google Calendar and Slack twins, their fault
scenarios and operation contracts, plus the server requirements model's 30
advisory rules (A1–A30). Direct calls to that session's twins established the
operations the design relies on: Gmail `messages.send`, `messages.list?q=rfc822msgid:`
and `messages.get`; Calendar insert with a client event id (409 on a repeat) and
get by id (events.list is not simulated: 501); HubSpot deal create (only
`dealname`/`pipeline`/`dealstage`; custom unique properties rejected: 501),
deal search (`EQ`, `CONTAINS_TOKEN`) and get with contact association; Slack
`conversations.history`.

Business rules the contract encodes:

| Rule | Check ids |
|---|---|
| One contact per email (adopted, never overwritten), one deal per lead, read back after writing | `baseline`, `existing_contact_adopted`, `reconcile_reads_back` |
| Resubmitted / concurrent submissions of a lead: one run, one of each effect | `resubmitted_lead_joins_run`, `concurrent_first_submissions` |
| Bad input rejected before any write | `invalid_input_rejected` |
| Timeout = unknown outcome: read back before any repeat, never a blind repeat | `hubspot_deal_response_loss`, `gmail_send_response_loss` |
| Email unconfirmed: 3 lookups (production +10/+20/+30 min), no resend, no event, Slack handoff naming the person, lead, blocked step and instructions | `gmail_unresolved_handoff`, `email_confirmation_spacing_30_minutes` |
| Calendar event only after the email is confirmed | `baseline`, `gmail_send_response_loss`, every Gmail failure check |
| Refusals / auth / rate limits: bounded re-checks, then a handoff; no silent failure | `gmail_send_rejected`, `gmail_send_rejected_once`, `gmail_auth_failure`, `gmail_rate_limited`, `hubspot_auth_failure`, `hubspot_scope_denied`, `hubspot_rate_limited`, `hubspot_token_expired`, `calendar_auth_failure`, `calendar_rate_limited` |
| Slack failures are recorded as failed, never as sent | `slack_channel_not_found`, `slack_not_in_channel`, `slack_missing_scope`, `slack_rate_limited`, `slack_slow_network_single_post` |
| Durable state across a real restart; no resend | `restart_during_confirmation` |

Run settings recorded in the contract (`appEnv`): confirmation lookups 15 s apart
(production 10 min), re-check delay 3 s (production 2 min), client timeout 4 s,
local tick 1 s, Slack channel and handoff person from runtime config.

## Runs (FetchSandbox relay runner `verify/relay-proof.mjs`, MCP 0.7.30)

| Attempt | App version | Run | Held / violated / unmeasured | What changed before the next attempt |
|---|---|---|---|---|
| — | `48d4ded`+uncommitted | session `vs_915f48a0c847` | aborted by me before configuration (runner stamped a commit without the code) | Committed first. The aborted runner's relay lease then blocked new tunnels for ~32 min (known R13 relay-cleanup gap). |
| 1 | `dda0b2a` | [`vr_dd3b2f55…`](https://fetchsandbox.com/runs/65843524b8?flow=vr_dd3b2f5575264676b683b4ebff213060) | 0 / 0 / 26 — baseline "required observation 'detail.verified' is missing"; other checks not run | Run view: scalar receipt details flattened to `detail_<key>`; contract selectors changed accordingly (observation path, same meaning). Also `tickEvery` added (deployment schedule only). |
| 2 | `64f8951` | [`vr_7ca7b94f…`](https://fetchsandbox.com/runs/328dca20f5?flow=vr_7ca7b94f791449a894076affa41effd9) | 0 / 0 / 26 — "'detail_verified' is missing" (saved run had it on the HubSpot actions) | Flattened fields and `errorCode` present on every action (null when absent): the verifier needs a predicate's field on every `actions[*]` element. |
| 3 | `0cdf990` | [`vr_e517c9d0…`](https://fetchsandbox.com/runs/ce57913e9d?flow=vr_e517c9d04e2d4b61b45057cfe7fd3501) | 14 / 6 / 6 | App: HubSpot read-back after an ambiguous create deferred to the scheduled re-check. Contract: `hubspot_token_expired` moved last (it permanently expired the shared HubSpot twin credential, so every later check was blocked at HubSpot and never reached its own fault); exact `duplicateStarts` equality removed (the verifier drives each check twice). |
| **4** | **`9a83348`** | [**`vr_4189ea30…`**](https://fetchsandbox.com/runs/cf367de3ef?flow=vr_4189ea30a65d443fb39db3370daae9a2) | **23 / 0 / 3** — verdict `inconclusive` | — |

Attempts 1–3 receipts are kept next to this file. Attempt 4 is the checked-in
receipt (`acme-ops/verify/receipts/lead-follow-up.json`), read back over HTTPS
(200) on November 14, 2026. Because the app, view and contract changed between
attempts, attempt 4 is **not** a same-contract before/after proof of a bug fix;
it is the measured result of the final contract on the final code.

## Attempt 4: expected vs actual (saved runtime state, independent twin state)

| Check | Expected | Actual | Status |
|---|---|---|---|
| baseline | 1 contact, 1 verified + associated deal, 1 confirmed email, then 1 event, 1 Slack completion | all applied, outcome ok; twin counts 1/1/1/1/1 | held |
| existing_contact_adopted | seeded contact adopted, firstname untouched | `created:false`, 1 contact, firstname "Augusta" | held |
| resubmitted_lead_joins_run / concurrent_first_submissions | one run, one of each effect | one run, effects 1 each (also after the verifier's second drive) | held |
| invalid_input_rejected | 400s, no run, no writes | 4 × 400, 0 runs, 0 contacts/emails | held |
| reconcile_reads_back | every effect reads back as `match` | 5 × match | held |
| hubspot_deal_response_loss | create held → no repeat; re-check finds the deal | timeout at +4 s, re-check +3 s found it by token + GET, 1 deal, run ok | **unmeasured**: "Accepted response read-back needs an accepted write, observed client disconnect and subsequent direct read of the same provider effect" (owner-only evidence; same result with immediate and deferred read-back) |
| gmail_send_response_loss | no resend, confirmed by lookup 1, then booked | `confirmation lookup 1/3`, `sendAttempts 1`, 1 email, 1 event | held |
| gmail_unresolved_handoff | 3 lookups, no resend, no event, handoff | 3 lookups ≈15 s apart (06:57:59, 06:58:15, 06:58:30Z), `delivery_unconfirmed`, 1 email, 0 events, Slack handoff with `<@owner>`, lead, step, instructions | held |
| gmail_send_rejected / _once / auth_failure / rate_limited | as named | 0 emails and handoff; once-refused sent on attempt 2 | held |
| hubspot_auth_failure / scope_denied / rate_limited / token_expired | blocked at HubSpot, nothing downstream, handoff | as expected; 0 deals, 0 emails | held |
| calendar_auth_failure / rate_limited | email stays single, handoff for the event | as expected | held |
| slack_channel_not_found / not_in_channel / missing_scope / rate_limited | notification recorded failed, never sent | failed with the provider code; 0 Slack posts | held |
| restart_during_confirmation | restart while the email is unconfirmed; no resend; confirmed after recovery | real restart; new process confirmed on lookup 1/3, `sendAttempts 1`, booked | held |
| slack_slow_network_single_post | single post under a 3 s Slack delay | declared, not executed | **unmeasured** (no evidence type fits a latency-only fault; local test only) |
| email_confirmation_spacing_30_minutes | lookups 10 min apart | declared, not executed | **unmeasured** (run used 15 s; production spacing tested with an injected clock locally) |

## Not established by this evidence

- Live OAuth consent, real SMTP delivery or inbox placement (Gmail `SENT` label =
  Gmail accepted the send), real HubSpot search-index lag, a deployed AgentCore
  runtime or its EventBridge tick schedule, and a real web-form adapter (none is
  included; `start` is called directly).
- When Slack itself is down or misconfigured the team is **not** notified; the
  failure is visible only in the run record (`slack.notify_team` failed,
  outcome `partial`).
- A process killed *during* an in-flight provider call leaves that step's claim
  held; the run is not resumed automatically (existing engine limitation, not
  measured). The email write-ahead marker still prevents a resend.
