# Customer handoff agents: FetchSandbox verification through the managed relay

- **App:** `apps/quote-agent`, customer handoff (`quote_agent/handoff/`) on top of the quote workflow.
  - CRM agent: HubSpot lifecycle stage set to `customer`, read back.
  - Billing agent: one Stripe invoice for the sent quote's total, finalized, read back.
  - Messaging agent: one Resend welcome email, read back.
  - Research agent: read-only account brief.
- **Date:** 2026-10-16
- **Tooling:**
  - `fetchsandbox-mcp` 0.7.28, run locally over stdio. That is what provides `manage_tunnel`; the hosted MCP doesn't have it.
  - The suite was `application_workflow_v1`. FetchSandbox drove the real app process on `127.0.0.1:8011` through its managed relay.
  - The contract was built by `apps/quote-agent/verification/handoff_contract.py`.
- **Classifier:** rule-based. No Anthropic key was used.

## Receipts

| Attempt | Session / run | Contract | Verdict |
|---|---|---|---|
| 1 | `vs_7b4981a0837a` / `vr_80b5c064cd3c4c8785644a2e8d2dda5e` | `quote-agent-handoff@1` | 18 held, 0 violated, 3 unmeasured |
| 2 | `vs_a536cdd1a634` / `vr_8013cf6db26f4982a0581b8021d70838` | `quote-agent-handoff@2` | **20 held, 0 violated, 1 unmeasured** |

- Attempt 1: https://fetchsandbox.com/runs/dd45ed5419?flow=vr_80b5c064cd3c4c8785644a2e8d2dda5e
- Attempt 2: https://fetchsandbox.com/runs/f1d3d78d6c?flow=vr_8013cf6db26f4982a0581b8021d70838

Owner access may be required for both. Preflight passed both times: through the relay, the observer returned 200 with the verifier token and 401 without it.

## Held in attempt 2 (judged by FetchSandbox from the app's saved state)

- **Baseline.** A quote from the quote agent (Slack twin reply) is handed off:
  - The HubSpot contact becomes `customer`.
  - One Stripe invoice for $15,000.00 is created.
  - One welcome email is sent.
  - All three steps are verified by reading the provider back.
- **Approved discount.** A 25% discount approved by a manager is what gets invoiced: $11,250.00.
- **Only the sent quote can be handed off.** A quote waiting on approval, or one superseded by a revision, gets 409 and no run.
- **Duplicates.**
  - Starting the same handoff twice gives one run, one invoice and one email.
  - Four overlapping starts give the same result.
- **The gate between steps.** Each fault stops the run at the step that hit it, and later steps don't run. After `provider_control` clears the fault, an operator retry completes the run with exactly one invoice and one email.
  - HubSpot 401, 429 and 403 (scope): nothing billed, nothing sent.
  - Stripe 401, 429 and 503: nothing sent. The retry reuses what the first attempt made.
  - Resend 401 and 429: the email step fails visibly.
- **Resend 503 then recovery.** The client retries with the same `Idempotency-Key` and the run completes on its own, with one email.
- **Contain.** With the billing agent contained, the run is blocked before any Stripe call. Release and retry complete it once.
- **Pause.** A paused run starts no new step, even after its blocked step is retried. Resume finishes it with one invoice and one email.
- **Restart.** FetchSandbox asked for a native restart between quote and handoff. The process was restarted on the same database, and the handoff completed exactly once.
- **Research.** The brief reads only allowlisted fields, never the email address, and writes nothing.

## Still unmeasured: `email_response_loss` (environment blocker, not an app failure)

- **FetchSandbox, both attempts:** "accepted requests=3, disconnect witnesses=0, matching-retry releases=0".
- **The app, both attempts, from its saved action log:** `allowed → uncertain (ReadTimeout after 8 s) → reconciling → reconciled → verified`. That is one email id per run, from a same-key resend.
  - Attempt 1: `11f6dabe-1047-4ebf-ba67-30cc69c9c252`.
  - Attempt 2: `1bffdb89-725a-4df3-b4f8-f5f42e630432`.
- **The arm/probe path.** Run earlier through the hosted MCP, it also left `resend:accepted_response_loss` inconclusive. Read straight from the twin afterwards, that recipient had exactly one email.
- **Likely cause.**
  - This cloud container must send all outbound HTTPS through a local proxy, which re-terminates TLS and tunnels to a policy egress proxy (`/root/.ccr/README.md`).
  - The app does close its connection when the read times out. The twin evidently never sees that hang-up, so the hold is never released as a disconnect.
  - The proxy can't be bypassed from this session.
  - Re-running the check unchanged would give the same result, so it was not repeated.
- **To measure it:** run the same contract from a machine without an intercepting egress proxy (a laptop, or CI).

## Problems found in my own work and fixed (not FetchSandbox or app defects)

1. **The baseline found a real gap against the Stripe twin.**
   - The twin returns `501 "Invoice action options are not simulated"` for `POST /v1/invoices/{id}/finalize` with options.
   - The invoice is already created with `auto_advance=false`, so finalize no longer sends options.
   - The run had stopped at billing with **no email sent**, which is the gate working. Retrying the same run reused the draft invoice: same id, one line, one customer.
2. **Contract v1 expected a Resend 503 to need an operator retry.** The app's same-key retry recovers by itself, and the scripted retry correctly got a 409 because there was nothing to retry. The check was corrected in v2.
3. **My poller missed the restart checkpoint in attempt 1**, so the app was never restarted. Fixed in attempt 2, where the check held.
4. **Arm/probe read-back.** In the hosted arm/probe run, the harness's independent read-back used no run header while the probe was armed. FetchSandbox reported that as "uncorrelated or overlapping traffic". The read-back now runs only after the probe is evaluated.

## Sandbox (twin) behavior worth knowing

| Area | Twin behavior | Real provider |
|---|---|---|
| Stripe `Idempotency-Key` | Ignored: two `POST /v1/customers` with one key made two customers | The same key returns the original object |
| Stripe `/v1/invoices/search`, `/v1/customers/search` | Return canned records, ignoring `query` | Filter by query |
| Stripe finalize with options | 501 `fetchsandbox_unsupported_capability` | Supported |
| Resend `GET /emails` (list) | Mostly canned records | Account's emails |

The billing agent was designed not to depend on the first two. It looks the customer and the run's invoice up before creating either.

## Arm/probe results (hosted MCP, caller-executed path)

These came from session `vs_6d3393b60ba5`, before the relay run. Every probe returned `inconclusive` / `app_verified: false`, because this path judges refusals only. The app outcomes were read from its saved state and from the twins:

- **Stripe 401 / 429 / 503:** billing failed, no invoice, no email.
- **HubSpot 401 / 429 / 403:** CRM failed, nothing billed or sent.
- **Resend 401 / 429:** email failed visibly.
- **Resend 503:** recovered inside the client with the same key, one email.
- **`bounced@resend.dev`:** the email step failed verification on `last_event: bounced`.
- **HubSpot write-not-verified and duplicate-on-retry:** completed, one invoice and one email.

Retries inside the HTTP clients (429 and Resend 5xx) are not counted in a step's `attempts`, which counts step executions.

## Session notes

- Credentials came only through `install_test_credentials` (a private dotenv file, loaded by the launcher and never printed).
- Both temporary files were deleted afterwards. The tunnel was closed, and the app and the local MCP process were stopped.
- No live provider credentials were used.
