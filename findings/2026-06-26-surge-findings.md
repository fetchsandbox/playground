# surge — 2026-06-26

## Prompt (verbatim from PROTOCOL.md)

> ./fetchsandbox we got a TCPA complaint about texting opted-out customers — investigate the surge integration.

## Tool-call sequence

1. `mcp__fetchsandbox__guide(intent="we got a TCPA complaint about texting opted-out customers — investigate the surge integration")`
2. Searched the catalog for the Surge spec.
3. Read local spec-related files before remote lookup.
4. Listed available workflows from the catalog entry.
5. Attempted `mcp__fetchsandbox__run_workflow(...)` before importing the spec.
6. `mcp__fetchsandbox__import_spec(...)`
7. Fetch(`https://surge.app/docs/api`) → 404
8. Fetch(`https://docs.surge.app`)
9. Fetch(`https://api.surge.app/openapi.json`)
10. `mcp__fetchsandbox__import_spec(...)` using the discovered OpenAPI specification.
11. `mcp__fetchsandbox__run_workflow(...)` — `verification_lifecycle_opt_in_compliance`
12. `mcp__fetchsandbox__run_workflow(...)` — `send_message_observe_delivery_lifecycle`
13. Read(`main.py`)
14. Update(`main.py`) — added an opt-out guard in `send_reminder`
15. Update(`main.py`) — added `contact.opted_out` webhook handling
16. `mcp__fetchsandbox__run_workflow(...)` (re-run after the fix)

## What the brain returned

- spec: surge
- workflow: verification_lifecycle_opt_in_compliance
- scenario: send_message_observe_delivery_lifecycle
- intent_class: debug
- bug_pattern matched: None
- confidence: Below 0.75

## Receipt URLs surfaced

- before: https://fetchsandbox.com/runs/79a1c46b60?flow=run_b3f969b7-915a-4046-af7b-0d9f6b562b1c
- after: https://fetchsandbox.com/runs/79a1c46b60?flow=run_6b41ca5e-f526-4834-bae3-86237f1a9833

## What the agent identified as the bug

Root cause — two bugs in main.py:

1. send_reminder (line 49) never checks `sms_status` before sending thereby opted-out contacts get texted anyway.
2. surge_webhook (line 73) only handles `message.delivered` thereby `contact.opted_out` events are silently dropped, so `sms_status` is never set to `opted_out`.

## What the agent's fix was

1. Added an opt-out guard in `send_reminder` that returns HTTP 403 when `sms_status == "opted_out"` before calling the Surge API.
2. Added handling for the `contact.opted_out` webhook event to update the contact's `sms_status` to `"opted_out"` when the event is received.

## Brain quality rating (1-10)

8/10

Justification:

The brain correctly identified the Surge spec, selected the appropriate TCPA compliance workflow, produced meaningful before and after receipt URLs, and helped identify both planted bugs. The ultimate explanation clearly connected the fixes with the compliance workflows.

However, there were still a few issues/ gaps:

- Initial confidence was below 0.75 because no bug pattern exists for this failure mode.
- The agent attempted to execute `run_workflow` before importing the spec, which was wrong method resulting in an avoidable execution error before recovering.
- Although the catalog already contained the Surge spec, the agent still searched for the OpenAPI specification remotely before successfully importing it.

Overall, FetchSandbox remained central to the investigation and provided meaningful validation rather than simply serving as a routing step.

## Did FetchSandbox earn its place in this session?

Yes.

FetchSandbox remained involved throughout the investigation. It selected an appropriate compliance workflow, generated meaningful before and after receipt URLs, and validated the fixes against the Surge sandbox. Although there were minor workflow sequencing issues and unnecessary remote spec discovery, the sandbox substantially contributed to reproducing and validating the issue.

## Specific suggestion for the brain.yaml for this spec

- id: sms_opt_out_compliance_gap

- symptoms:
  - opted-out customers still receive SMS
  - TCPA complaint after reminder messages
  - reminder sent after unsubscribe
  - opt-out webhook ignored
  - SMS compliance failure

- reproduce_with workflow + scenario:
  - workflow: verification_lifecycle_opt_in_compliance
  - scenario: opted_out_contact

- check_for items:
  - `send_reminder` verifies `sms_status` before sending
  - `contact.opted_out` webhook updates contact status
  - reminder flow blocks opted-out contacts
  - webhook handles consent lifecycle events
  - compliance workflow passes before message delivery

## What surprised you

Compared to last day's Clerk session, the brain performed significantly better by identifying a workflow relevant to the reported issue and validating it with receipts instead of relying primarily on the local source-code inspection. However, it still attempted to execute a workflow before importing the spec and performed unnecessary remote OpenAPI lookups even though the Surge spec already existed in the catalog.