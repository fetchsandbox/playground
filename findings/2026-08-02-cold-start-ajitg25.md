# cold start — happy path + failure per spec — 2026-08-02

**Prompt:** Zero prior context. Hit each spec with one happy path + one failure case. Report top 3 risks/blockers, best moment, worst moment, confidence 1–5.

**Agent / IDE:** Claude Code (Sonnet 4.6 1M), MCP via `npx fetchsandbox-mcp@latest`, called programmatically via JSON-RPC over stdio.

**Specs tested:** Stripe, Resend, Clerk, Descope, AgentMail

---

## What happened

For each spec, called `guide` twice — once with a happy-path intent, once with a failure/bug intent — then ran `quickrun` on whatever was returned. No prior knowledge of workflows, bug patterns, or sandbox IDs used.

---

## Per-spec results

| Spec | Happy route | Happy result | Failure route | Bug pattern | Failure result |
|---|---|---|---|---|---|
| Stripe | `accept_payment` @ 0.85 | **pass 6/6** | `accept_payment` @ 0.95 | `webhook_duplicate_side_effect` | pass 6/6 |
| Resend | `send_email` @ 1.0 | **pass 3/3** | `send_email` @ 0.95 | `bounce_complaint_silent_drop` | **ERROR — undefined response** |
| Clerk | `user_signup` @ 1.0 | **pass 4/4** | `user_signup` @ 0.95 | `session_token_401_loop` | pass 4/4 |
| Descope | `otp_signup_email` @ 0.85 | **pass 3/3** | `session_refresh` @ 0.95 | `session_not_refreshed` | pass 3/3 |
| AgentMail | `inbox_create_and_subscribe_webhook` @ 0.85 | **pass 4/4** | `inbox_create_and_subscribe_webhook` @ 0.85 | none | pass 4/4 |

---

## Receipt URLs

| Spec | Run | URL |
|---|---|---|
| Stripe | happy | https://fetchsandbox.com/runs/fbd931b872?flow=run_48875371-8ad3-4706-a423-8964f55ef1d5 |
| Stripe | failure | https://fetchsandbox.com/runs/fbd931b872?flow=run_50d4e292-a122-4677-9fab-c00d5673f8c6 |
| Resend | happy | https://fetchsandbox.com/runs/3e579e701c?flow=run_a4b4b5d7-a805-4ff6-9658-4b5c9714ba9d |
| Resend | failure | — (errored) |
| Clerk | happy | https://fetchsandbox.com/runs/75cf1b5dcc?flow=run_1241df59-dbac-444b-a013-d496b9af4be4 |
| Clerk | failure | https://fetchsandbox.com/runs/75cf1b5dcc?flow=run_a0e7311d-d192-40bb-b097-029a28e753f5 |
| Descope | happy | https://fetchsandbox.com/runs/62708902b3?flow=run_ec459545-6277-448e-bd75-35d94c1961a3 |
| Descope | failure | https://fetchsandbox.com/runs/62708902b3?flow=run_84998887-a5a6-44f7-b722-06c89b65999f |
| AgentMail | happy | https://fetchsandbox.com/runs/7a43e813b3?flow=run_8eefb4d9-402e-4ea3-9204-2e3fc0d42235 |
| AgentMail | failure | https://fetchsandbox.com/runs/7a43e813b3?flow=run_be0c9780-c7a7-4660-b480-fde3bd0dccb7 |

---

## Top 3 risks / blockers

### 1. FG-4 is systemic — failure scenarios return green receipts on 3 of 5 specs

Stripe (`webhook_duplicate_side_effect`), Clerk (`session_token_401_loop`), and Descope (`session_not_refreshed`) each had a named bug pattern matched at ≥0.95 confidence — then `quickrun` with that bug's scenario returned `status=pass` with a shareable receipt URL.

The receipts for the Stripe failure run and the Stripe happy run are **visually identical** (`pass 6/6`, same sandbox, different flow ID). A developer who follows guide → quickrun → share receipt gets the same artifact whether their code is broken or fixed.

This was first identified on Thursday (FG-4, Stripe only). Seeing it repeat on Clerk and Descope cold confirms it is architectural: `quickrun` tests the reference sandbox, which always handles scenarios correctly. The user's code is never in the loop.

### 2. Resend failure quickrun crashed silently

`quickrun(resend, send_email, bounced_email)` returned an undefined/malformed response — no `status`, no `share_url`, no error field. The tool call succeeded (no exception thrown), but the result was unusable. A developer following the guide for a bounce bug would hit this dead end with no feedback on what failed or what to try next.

### 3. AgentMail has no failure surface from a cold start

Guide returned the identical workflow (`inbox_create_and_subscribe_webhook`) for both the happy intent and the failure intent, no bug_pattern matched, and both quickruns returned the same pass receipt. There is no way to distinguish "integration is healthy" from "integration is broken" for AgentMail without reading the code directly. The brain needs at least one named bug pattern — the `event_type` field mismatch found Thursday is a concrete candidate.

---

## Best moment

**Resend happy path at conf=1.0.** The only spec to hit maximum confidence on the first call. Named `send_email` directly from the intent without ambiguity, no next_question required. Routing felt instant and authoritative.

---

## Worst moment

**Three green failure receipts in a row.** After guide correctly named `webhook_duplicate_side_effect` (Stripe), `session_token_401_loop` (Clerk), and `session_not_refreshed` (Descope) at ≥0.95 confidence, each quickrun came back `pass`. Watching the same `status: pass, 6/6` appear for a "prove my bug reproduces" run as for a "prove my integration works" run — with a shareable URL each time — is the clearest possible demonstration that the receipt format does not communicate what was actually tested.

---

## Confidence: 3/5

Happy paths are reliable and fast — all 5 passed with real receipt URLs. Routing is strong on known specs (Stripe, Resend, Clerk, Descope). The confidence deduction comes entirely from the failure surface: three specs returned green receipts on their own bug scenarios, one crashed silently, one had no bug pattern at all. If a developer ran this cold and shared the failure receipts as proof their bug is fixed, they'd be wrong in 4 of 5 cases.

**What would make this a 5/5:** Chain `verify_behavior` automatically after `quickrun` when a scenario is passed, and surface the buggy vs. fixed diff in the receipt. The routing layer is good enough to carry that — the gap is in what happens after the route is confirmed.
