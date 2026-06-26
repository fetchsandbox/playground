# resend — 2026-06-24

## Prompt (verbatim from PROTOCOL.md)

> ./fetchsandbox resend webhook handler may be silently dropping bounce events — users keep getting marked active even after they bounce. investigate and fix.

## Tool-call sequence

1. mcp__fetchsandbox__guide(intent="resend webhook handler may be silently dropping bounce events...")
2. mcp__fetchsandbox__import_spec(spec="resend")
3. mcp__fetchsandbox__run_workflow(workflow="send_email", scenario="bounce")
4. Read(main.py)
5. Edit(main.py) — added handling for `email.bounced` and `email.complained`
6. mcp__fetchsandbox__run_workflow(...) (re-run after fix)

## What the brain returned

- spec: resend
- workflow: send_email
- scenario: bounce
- intent_class: debug
- bug_pattern matched: None
- confidence: 0.85

## Receipt URLs surfaced

- before: https://fetchsandbox.com/runs/29b3775a94?flow=run_35c8864f-7507-4390-8d09-424837bc0a54
- after: https://fetchsandbox.com/runs/29b3775a94?flow=run_1d49f534-e8c5-4f08-bc53-5fe0a112bb15

## What the agent identified as the bug

"resend_webhook (line 79, before fix) only matched email.delivered. Every email.bounced and email.complained event fell through to return {'received': True} with no side-effect — leaving email_status permanently 'active'."

## What the agent's fix was

- Added `elif event_type == "email.bounced"` and set `email_status = "bounced"`
- Added `elif event_type == "email.complained"` and set `email_status = "complained"`
- Extracted email lookup before the event branches so all handlers share the same lookup logic

## Brain quality rating (1-10)

8/10

Justification:

The brain correctly routed the issue to the Resend spec, selected the send_email workflow, reproduced the issue in a sandbox, generated proof receipts, and guided the investigation. However, no dedicated bug pattern existed for this failure mode, so the agent still had to reason about the local code to identify the exact root cause.

## Did FetchSandbox earn its place in this session?

Yes

FetchSandbox was used from the start of the session. The agent followed the dispatch convention, imported the Resend spec, reproduced the issue through the sandbox, generated before/after receipts, and validated the fix. Even without a dedicated bug pattern, the MCP was central to the workflow.

## Specific suggestion for the brain.yaml for this spec

- id: bounce_complaint_silent_drop
- symptoms:
  - users remain active after bounced emails
  - bounce events not reflected in user records
  - complaint events ignored
  - resend webhook silently dropping events
  - deliverability status not updating

- reproduce_with workflow + scenario:
  - workflow: send_email
  - scenario: bounce

- check_for items:
  - webhook handles email.bounced
  - webhook handles email.complained
  - email_status updated correctly
  - bounced users are not treated as active
  - complaint state persists in user records

## What surprised you

Even without a dedicated Resend bug pattern, the agent successfully used FetchSandbox to reproduce the issue, locate the root cause, apply a fix, and generate proof receipts.