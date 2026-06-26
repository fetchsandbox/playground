# surge — 2026-06-26

Prompt: `./fetchsandbox we got a TCPA complaint about texting opted-out customers — investigate the surge integration`

Agent / IDE: Claude Code (Opus 4.8), MCP via `.mcp.json` in `apps/surge/`.

Receipt URLs:

- before: https://fetchsandbox.com/runs/79a1c46b60?flow=run_b3f969b7-915a-4046-af7b-0d9f6b562b1c
- after: https://fetchsandbox.com/runs/79a1c46b60?flow=run_6b41ca5e-f526-4834-bae3-86237f1a9833

What happened:

The brain routed the request to the Surge spec but only at **below 0.75 confidence**, indicating there is no curated bug pattern yet for this failure mode. It correctly identified the TCPA-related `verification_lifecycle_opt_in_compliance` workflow and attempted to reproduce the issue. The agent initially tried to execute a workflow before importing the spec, recovered by importing the Surge OpenAPI specification, and then executed both the compliance workflow and the message delivery lifecycle.

The before receipt demonstrated that reminder messages were being sent without checking opt-out status. While auditing `main.py`, the agent identified two defects:

1. `send_reminder` never checked `sms_status` before sending SMS, allowing opted-out contacts to continue receiving reminder messages.
2. `surge_webhook` only handled `message.delivered` events and silently ignored `contact.opted_out`, so contacts never transitioned to an `"opted_out"` state.

The agent applied both fixes, re-ran the FetchSandbox workflow, and produced an after receipt confirming the compliance flow passed successfully.

Overall, the brain was considerably more useful than in the Clerk session. It selected an appropriate workflow, remained involved throughout the investigation, produced meaningful before/after receipts, and validated the final fix. The primary gaps were the low routing confidence, attempting to execute `run_workflow` before `import_spec`, and unnecessary remote OpenAPI lookups even though the Surge catalog already contained the required spec. **Score: 8/10.**