# postbox — 2026-07-21

**Prompt:** `./fetchsandbox i am working on this project called postbox and its not working as expected, i feel there is a bug in the code. can you look into the code and fix it use fetchsandbox mcp as required`

**Agent / IDE:** Claude Code (Sonnet 4.6 1M), MCP via `.mcp.json` in `stress-test/02-postbox/`.

**Receipt URLs:**
- Bug (bounce/complaint silent drop): https://fetchsandbox.com/runs/10777ecf13?flow=run_4b4ca951-366a-424d-bde8-164889ce4ebe

**What happened:**

Read `server.js` and saw it was a Resend-backed transactional email service with a `/webhook` endpoint, `/send` broadcast, and `/contacts` list. Called `guide` with the full symptom description and a `resend` spec hint — it routed to `send_email` workflow and surfaced the `bounce_complaint_silent_drop` bug pattern at 92% confidence via the memory graph.

The pattern matched immediately: the webhook `switch` only handled `email.sent`, `email.delivered`, `email.opened`, and `email.clicked`. No branch for `email.bounced` or `email.complained`, so those events were silently dropped and affected contacts stayed `status: 'active'` forever — meaning the `/send` endpoint kept broadcasting to bounced and complained addresses (CAN-SPAM violation).

Imported the Resend spec (`import_spec` with the resend/resend-openapi raw URL), ran `run_workflow` on `send_email` to get a `sandbox_id` + `flow_run_id`, then called `verify_behavior` with `bounce_complaint_silent_drop`. Probe confirmed: buggy handler returns 200 on a send to a bounced address, fixed handler returns 403.

Fix was a single edit — added two cases to the switch in `server.js:56-62`: `email.bounced` sets `contact.status = 'bounced'`, `email.complained` sets `contact.status = 'complained'`. The existing `/send` filter (`status === 'active'`) then naturally excludes suppressed contacts with no further changes needed.

One stumble: first `guide` call without a spec hint returned low confidence and asked a clarifying question. Second call with `hints: { spec: "resend" }` surfaced the pattern immediately. Also initially called `verify_behavior` without a `sandbox_id`/`flow_run_id`, so the diff wasn't saved to a receipt — had to redo the full `import_spec` → `run_workflow` → `verify_behavior` chain to get the shareable URL. Score: 8/10 (pattern match and fix were clean; the two wasted calls — one on guide, one on verify_behavior — could have been avoided by following the correct tool sequence from the start).
