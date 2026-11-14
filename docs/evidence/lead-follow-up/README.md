# Lead follow-up — verification record

Sanitized evidence for the [lead follow-up workflow](../../workflows/lead-follow-up.md)
(`acme-ops/src/workflows/lead-follow-up.ts`). Synthetic `example.test` leads on
isolated FetchSandbox twins only: no live HubSpot, Gmail, Calendar or Slack
account was used, no real email was sent and no real customer record was created.

# Revision 2 — November 14, 2026

**Fresh receipt:** [`vr_2b5550810ed94ba6ae8b98114cc0bb8f`](https://fetchsandbox.com/runs/3d902dfd1a?flow=vr_2b5550810ed94ba6ae8b98114cc0bb8f)
(app `acme-ops-lead-follow-up-1.0.0-e09e6da`, session `vs_e9c58347a4ec`, MCP 0.7.30):
**25 held, 0 violated, 5 unmeasured** of 30 declared checks; verdict `inconclusive`
(FetchSandbox does not call a contract verified while any declared check is unmeasured).
Read back over HTTPS (200) on November 14, 2026.

## What changed in the app (revision 2)

- **Agreed email schedule:** after an unknown send, an initial lookup right away, then
  lookups 15 and 30 minutes after the send (anchored to the send time, so a late wake-up
  never shifts the schedule), then the Slack handoff; never a resend.
- **Stale workers:** a claim left `running` by a worker that died mid-call is taken over by
  the (reconcile-first) step after `STALE_CLAIM_MS`; the tick resumes runs left
  `RUNNING`/`APPROVED` (or `WAITING` with nothing scheduled) after `STALE_RUN_MS`.
- **Defect found and fixed:** two workers driving one run could strand it in `WAITING` with
  everything applied (the loser settled while the winner still applied effects, then the
  winner skipped its settle). Reproduced in about half of local runs; 12/12 after the fix.
- HubSpot re-check after an ambiguous create waits a retry interval (CRM search lags writes);
  Slack reconciliation reads use a patient timeout; per-provider timeouts; deferred steps
  record their reason as run events; the run view exposes `error`, `errorCode` and
  `detail_<key>` on every action.
- Local tests: 377 passing (`npm test`), including a two-worker stale-claim race and a
  clock-driven check of the +0/+15/+30 schedule.

## Probe plan (contract revision 2)

Builder-proposed: FetchSandbox's requirements model returned `requirements_model_unavailable`
for this revision (session `vs_1e66584ab3b8`); the plan follows its recovery guidance and the
model's earlier advisory rules A1–A30. Discovery facts the plan relies on were measured on the
discovery twins: HubSpot and Gmail hold an accepted write's response for ~10 s, Slack
`slow_network` delays every response ~3 s and still commits a post whose client gave up.

| Check | Probe | Expected outcome | Evidence required |
|---|---|---|---|
| `baseline` | one new lead | 1 contact, 1 read-back-verified associated deal, 1 confirmed email, then 1 event, then 1 Slack completion | saved run + every twin's records for the lead |
| `existing_contact_adopted` | lead's email already a HubSpot contact (fixture, read back) | contact adopted, not duplicated or overwritten | `detail_created=false`; twin: 1 contact, firstname unchanged |
| `resubmitted_lead_joins_run` | same lead again, new submission id (driven twice by the verifier) | one run, nothing written twice | 1 run; twin counts 1/1/1/1/1 |
| `concurrent_first_submissions` | 5 concurrent first submissions | one run, one of each effect | 1 run; twin counts 1 each |
| `invalid_input_rejected` | bad email, unsafe lead ID, empty and blank name; run-state routes with no / a wrong token | 400 / 401, no run, no writes, no data | HTTP statuses; 0 runs; 0 contacts/emails |
| `reconcile_reads_back` | reconcile after completion | every effect reads back `match` | 5 × `reconciled=match` |
| `hubspot_deal_response_loss` | deal committed, response held ~10 s, client times out at 4 s | no repeat; the re-check after the hold finds it by token + GET; 1 deal | accepted_response_readback; `detail_via=lookup`; twin 1 deal |
| `gmail_send_response_loss` | send committed, response held | no resend; the **initial** lookup (agreed schedule) confirms; then the event | accepted_response_readback; `confirmation lookup 1/3`, `sendAttempts=1`; twin 1 email, 1 event |
| `gmail_unresolved_handoff` | send committed with response lost, every lookup unavailable, a real restart inside the window (relay suite: interval compressed to 20 s) | initial + 2 scheduled lookups anchored to the send (across the restart), no resend, no event, Slack handoff to the named person | refusal; saved lookup log and run events; twin 1 email, 0 events, handoff text |
| `email_confirmation_spacing_30_minutes` | **real time, production interval**: same fault, actual runtime, caller-executed FetchSandbox path | lookups at +0, +15, +30 min after the send, then the handoff | app lookup log; FetchSandbox flow record (13 Gmail requests, last activity at +30 min); twin read-back; probe verdict |
| `gmail_send_rejected` / `_once` | send always / once refused (403) | ≤3 tries, nothing sent, handoff / sent once on retry, then booked | refusal; twin email 0 / 1 |
| `gmail_auth_failure`, `gmail_rate_limited` | 401 / 429 on Gmail | blocked at email, nothing sent or booked, handoff | refusal; twin 0 emails, 0 events |
| `hubspot_auth_failure`, `hubspot_scope_denied`, `hubspot_rate_limited` | 401 / write 403 / 429 on HubSpot | blocked at contact, nothing downstream, handoff | refusal; twin 0 deals, 0 emails |
| `calendar_auth_failure`, `calendar_rate_limited` | 401 / 429 on Calendar | email stays single, handoff for the event | refusal; twin 1 email, 0 events |
| `slack_channel_not_found`, `slack_not_in_channel`, `slack_missing_scope`, `slack_rate_limited` | Slack `ok:false` / 429 | notification recorded failed, never as sent; other effects single | refusal; error code; twin 0 posts |
| `slack_slow_network_single_post` | every Slack response delayed ~3 s, post times out at 2 s | no blind repost; patient history read finds the marker; 1 post | accepted_response_readback; `detail_via=readback`; twin 1 post |
| `restart_during_confirmation` (stale worker) | runtime SIGKILLed by the runner 1.5 s after the app logs the Gmail send dispatch (send held by the twin); verifier restart on the same storage | stale claim taken over after 20 s; "maybe sent" marker forces a lookup, not a resend; confirmed; booked | accepted_response_readback; takeover event; `sendAttempts=1`; twin 1 email |
| `midrun_resubmission_while_waiting` | resubmission with another name/email while the deal re-check waits | joins the run, first submission's data used, nothing to the new address | twin: deal with original name, 1 email to original, 0 to changed, 0 contacts for changed |
| `two_leads_isolated` | two different leads | two runs, each only its own records | 2 runs; twin per-lead deal, email, event and post |
| `hubspot_token_expired` (last) | HubSpot token dies after 3 requests | stops at the failing step, handoff, no email | refusal; twin 0 deals, 0 emails |
| `midrun_provider_change_by_person` | a person creates the deal / sends the email by hand mid-run | adopted, not duplicated | **blocked (setup_missing)**: no qualified external-operator input on any of the four twins |
| `multi_worker_shared_store` | two live workers on one stored run | one claim owner, no duplicate, run finishes | **blocked (setup_missing)**: runner starts one process; local two-engine test only |

Not applicable (explained in the contract's coverage review): amounts/currency/quantity
(the deal carries none), cancellation/refunds/entitlements (none promised), requester
identity and tenant ownership (an internal form for one sales team; the runtime is reached
only through AgentCore IAM; ownership between leads is covered by `two_leads_isolated`).

## Attempts (revision 2)

| Attempt | App | Run | Held / violated / unmeasured | Finding → change before the next attempt |
|---|---|---|---|---|
| dry runs | `7e90d57`… | configure-only, cancelled | — | Server limits: ≤ 8 provider assertions per check; `engine_unsupported` refused for the mid-run provider change (recategorised `setup_missing`). Explicit 3300 s budget and 2100 s deadline accepted. |
| rev2-1 | `ecd867f` | [`vr_7f0015df…`](https://fetchsandbox.com/runs/007251338f?flow=vr_7f0015df3bd648dc9b52e798d52ea98c) | 7 / 0 / 23 | Real 30-minute check reached its +15.0 min lookup, then the **relay lease (1800 s, not renewable) expired**; every later check lost the app (HTTP 503 / no precondition). Relay suite: interval compressed (disclosed), `gmail_unresolved_handoff` restored, 30-minute timing moved to the caller-executed path. |
| rev2-2 | `2d08971` | [`vr_d8383d58…`](https://fetchsandbox.com/runs/e3dac80727?flow=vr_d8383d5812fd4123b6e858f8120a53cf) | 24 / 1 / 5 | `restart_during_confirmation` **violated**: FetchSandbox issued the restart ~19 s after the start; the run had finished in 6 s, so no worker died mid-call. The runner now SIGKILLs the runtime on the app's "gmail send dispatched" log line. |
| rev2-3 | `765d9ae` | [`vr_feb0c48d…`](https://fetchsandbox.com/runs/3b898b60bd?flow=vr_feb0c48dc4ab4495a117963951f10a17) | 24 / 0 / 6 | Killed before the request left the process: the restarted worker took over, found nothing, **never resent** and handed off after 3 lookups (safe outcome, not the intended probe). Kill delayed 1.5 s. |
| **rev2-4** | **`e09e6da`** | [**`vr_2b555081…`**](https://fetchsandbox.com/runs/3d902dfd1a?flow=vr_2b5550810ed94ba6ae8b98114cc0bb8f) | **25 / 0 / 5** | — |

Receipts of every attempt are kept next to this file. Contract and observation changes
between attempts are listed above; none removed or weakened a business assertion
(`verifier_reads_require_token`'s three 401 probes were folded into `invalid_input_rejected`
to stay within the 30-check limit; the compressed `gmail_unresolved_handoff` measures
behavior only and is not claimed as timing evidence).

## Fresh receipt: expected vs actual

| Check | Expected | Actual (saved run + twins) | Status |
|---|---|---|---|
| baseline | 1 contact, 1 verified associated deal, 1 confirmed email, then 1 event, 1 completion | all applied, outcome ok; twin counts 1/1/1/1/1 | held |
| existing_contact_adopted | contact adopted, not overwritten | `created:false`; 1 contact, firstname "Augusta" | held |
| resubmitted_lead_joins_run | one run, nothing twice | 1 run (3 submissions incl. the verifier's repeat), effects 1 each | held |
| concurrent_first_submissions | one run, one of each effect | 1 run (9 duplicate starts absorbed), effects 1 each | held |
| invalid_input_rejected | 400s; 401s without/with a wrong token; no run, no writes | as expected | held |
| reconcile_reads_back | every effect reads back `match` | 5 × match | held |
| hubspot_deal_response_loss | no repeat; re-check finds the deal | re-check after the ~10 s hold found it by token + GET (`via: lookup`); 1 deal | **held** (was unmeasured) |
| gmail_send_response_loss | no resend; initial lookup confirms | `confirmation lookup 1/3` at +0.1 min, `sendAttempts 1`; 1 email, 1 event | **unmeasured** (FetchSandbox evidence ordering, below) |
| gmail_unresolved_handoff | initial + 2 scheduled lookups across a restart, no resend, handoff | lookups +0.1/+0.3/+0.7 min (20 s interval), `delivery_unconfirmed`, 1 email, 0 events, handoff | held |
| gmail_send_rejected / _once / auth_failure / rate_limited | as named | 0 emails + handoff; refused-once sent on attempt 2 | held |
| hubspot_auth_failure / scope_denied / rate_limited / token_expired | blocked at HubSpot, nothing downstream, handoff | as expected; 0 deals, 0 emails | held |
| calendar_auth_failure / rate_limited | email single, handoff for the event | as expected | held |
| slack_channel_not_found / not_in_channel / missing_scope / rate_limited | recorded failed, never sent | failed with the provider code; 0 posts | held |
| slack_slow_network_single_post | no repost; history read finds the post; 1 post | `via: readback`, 1 post, run ok | **unmeasured** (FetchSandbox evidence, below) |
| restart_during_confirmation | worker dies mid-send; takeover; lookup, not resend; booked | SIGKILL 1.5 s after dispatch; takeover at +21 s; `confirmation lookup 1/3`, `sendAttempts 1`; 1 email, 1 event | **held** (new) |
| midrun_resubmission_while_waiting | joins, first data used, nothing to the new address | 1 deal "… Ada Lovelace", 1 email to the original, 0 to the changed address | held (new) |
| two_leads_isolated | two runs, each only its own records | 2 runs; per-lead deal, email, event, post 1 each | held (new) |
| email_confirmation_spacing_30_minutes | lookups +0/+15/+30 min, then handoff | relay: blocker (lease); measured via the caller-executed path below | **unmeasured** in the receipt |
| midrun_provider_change_by_person | adopted, not duplicated | — | **unmeasured** (setup_missing: no qualified external input) |
| multi_worker_shared_store | one claim owner, run finishes | local two-engine test only | **unmeasured** (setup_missing: single-process runner) |

## Real 30-minute schedule (production interval)

Measured on the actual runtime through FetchSandbox's caller-executed path (session
`vs_e1add4a4b703`, flow `vr_f4732f6e48a940458d69a1ea90c8e673`, Gmail fault
`direct_send_accepted_lookup_unavailable`, `LEAD_EMAIL_CONFIRM_INTERVAL_MS` unset = 15 min):

| Event | App record (UTC) | After the send |
|---|---|---|
| send marked / accepted by the twin | 15:36:48.169 / twin `internalDate` 15:36:48.233 | — |
| lookup 1 (initial) | 15:36:52.8 | +0.1 min |
| lookup 2 | 15:51:49.1 | +15.0 min |
| lookup 3 → handoff | 16:06:49.3 → Slack post 16:06:49.9 | +30.0 min |

FetchSandbox's own record of the flow: 13 Gmail requests (3 pre-send lookup attempts, 1 send,
3 × 3 lookup attempts; i.e. **no resend**), `last_activity_at` 16:06:49.245 (the +30 lookup).
Twin read-back: 1 message to the lead, 0 calendar events for the lead, 1 Slack handoff
containing the owner mention, `+0.1 / +15.0 / +30.0 min`, "MAY have been sent" and the
Message-ID search. FetchSandbox's probe verdict was **inconclusive — "attempt expired before
evaluation"** (the arm window is 900 s), the evidence scope is provider traffic
(`app_verified: false`), and the flow's share link is not publicly viewable. Details:
[`realtime-30-minute-schedule.json`](realtime-30-minute-schedule.json).

## Comparison with the previous receipt

Previous: [`vr_4189ea30…`](https://fetchsandbox.com/runs/cf367de3ef?flow=vr_4189ea30a65d443fb39db3370daae9a2)
(app `9a83348`, contract revision 1): 23 held / 0 violated / 3 unmeasured of 26.

| Previously unmeasured | Now |
|---|---|
| `hubspot_deal_response_loss` | **held** (re-check after the twin's hold) |
| `slack_slow_network_single_post` | executed; app outcome correct (1 post via read-back); still **unmeasured**: no FetchSandbox evidence type fits a latency-only fault |
| `email_confirmation_spacing_30_minutes` | real schedule **measured** outside the relay (+0.1/+15.0/+30.0 min); receipt entry **unmeasured** (relay lease 1800 s; probe window 900 s) |

| Other changes | |
|---|---|
| `gmail_send_response_loss` | held → **unmeasured**: the agreed schedule's initial lookup now runs ~4 s after the send, before the twin's ~10 s hold ends; the verifier only credits reads after it observes the disconnect |
| `gmail_unresolved_handoff` | held → held (now initial/+interval/+2×interval schedule, plus a real restart in the window) |
| `restart_during_confirmation` | was "restart while waiting" → now a real worker death mid-send with stale-claim takeover: held |
| New checks | `midrun_resubmission_while_waiting`, `two_leads_isolated` held; token probes in `invalid_input_rejected` held; two typed blockers added |

## FetchSandbox defects and limitations (not app defects)

1. **Relay lease shorter than the execution budget:** `manage_tunnel` leases expire after
   1800 s and cannot be renewed (a second open is refused until close; a new tunnel has a new
   URL), while the execution budget allows 3300 s. Real-time checks over ~25 min cannot run.
2. **Arm/probe window 900 s:** the caller-executed probe expired before evaluating a
   30-minute schedule ("attempt expired before evaluation").
3. **Read-back evidence ordering:** `accepted_response_readback` credits only reads after the
   twin's ~10 s hold ends, though the client disconnected earlier; an immediate, correct
   reconcile (the agreed initial lookup) cannot be credited.
4. **No evidence type for latency-only faults** (`slack:slow_network`).
5. **Restart checkpoint latency** (~19 s after the start action): a verifier-requested restart
   cannot land inside a short in-flight window; the runner had to kill the process itself.
6. **Share link** returned by `list_runs` for an owner session renders "Sandbox not found".
7. **Requirements model unavailable** for this revision (`requirements_model_unavailable`).
8. Carried from revision 1: a leaked relay lease after a killed client blocked new tunnels
   for ~32 min; `token_expired` permanently expires the shared twin credential for later
   checks; observations require a predicate's field on every array element; the tool schema
   text (64 KiB, evidence enum) disagrees with the live capabilities (128 KiB,
   `accepted_response_readback`).

## Remaining limits

- Not established: live OAuth, real delivery/inbox placement, real HubSpot search lag, a
  deployed AgentCore runtime and its tick schedule, a real web-form adapter, multiple
  containers on DynamoDB (local two-worker test only).
- If Slack itself is down or misconfigured, the team is not notified; the failure is visible
  only in the run record.
- A takeover that happens after a scheduled lookup's due time runs the missed lookups
  immediately (the schedule is anchored to the send); after a long outage two lookups can
  be back to back.


# Revision 1 — history

## Revision 1 runs (FetchSandbox relay runner `verify/relay-proof.mjs`, MCP 0.7.30)

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

## Revision 1, attempt 4: expected vs actual (saved runtime state, independent twin state)

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

## Revision 1: not established by this evidence

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
