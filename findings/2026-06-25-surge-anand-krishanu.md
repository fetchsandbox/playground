# surge - 2026-06-25

**Prompt:** `./fetchsandbox we got a TCPA complaint about texting opted-out customers — investigate the surge integration`

**Agent / IDE:** Claude Code (Opus 4.8), MCP via `.mcp.json` in `apps/surge/`.

**Receipt URLs:** none - see "proof gap" below. No workflow reproduces this failure mode, so there was nothing honest to receipt.

**What happened:**

Followed the dispatch convention. `guide` matched the `surge` spec at **0.6 confidence**
(below the 0.75 threshold) with `workflow: null`, `scenario: null`, no `fix_pattern`,
intent_class `debug`, reasoning "no curated workflow available; consider Tier-1 promotion."
So the automated path had nothing to execute so it fell back to a real code read.

**Bug is real and in the code (not the sandbox): opted-out customers keep getting texted.**
Two compounding defects, each a TCPA violation on its own:

- **Defect 1 - opt-out events dropped.** `surge_webhook` (main.py:73) only handles
  `message.delivered`. Every other event, including inbound `STOP`/opt-out, is silently
  ignored. `sms_status` is set to `"active"` once at creation (main.py:43) and never
  updated anywhere. Opt-out arrives → handler returns `{"received": True}` → nothing changes.
- **Defect 2 - send path never checks consent.** `send_reminder` (main.py:48) loads the
  contact and immediately POSTs to Surge (main.py:60) without ever reading
  `contact["sms_status"]`. Even with Defect 1 fixed, an `opted_out` contact would still
  get texted. No consent gate.
- **Secondary - webhook unauthenticated.** `surge_signature` is captured (main.py:76) and
  `SURGE_WEBHOOK_SECRET` is defined (main.py:21) but never verified, so opt-out/delivery
  events can be forged. Not the TCPA root cause, but relevant to hardening.

**Proof gap (honest):** I couldn't produce a FetchSandbox receipt and didn't fake one. The
brain doesn't encode this failure mode (0.6, no workflow/scenario/fix_pattern). The Surge
catalog has 6 workflows; the only compliance one is `verification_lifecycle_opt_in_compliance`,
which is opt-*in* (consent before first message), not opt-*out* (`STOP` handling). None
reproduce "text sent to an opted-out contact," so a happy-path run would prove nothing. The
real proof is the code itself: `sms_status` has one writer and zero readers.

**Fix proposed (not yet applied this session):** (1) webhook handles the opt-out event and
sets `sms_status = "opted_out"` (match by phone, like the delivery branch; optionally
re-activate on `START`); (2) `send_reminder` guards on `sms_status != "active"` → skip the
Surge call, return `409`.

**Brain usefulness:** low on this one as it had nothing runnable to offer and flagged itself
for Tier-1 promotion. Score: 3/10. The miss worth reporting upstream: there's an opt-in
verification workflow but **no opt-out/STOP-handling workflow or bug pattern**, so the most
common Surge compliance failure can't be reproduced or receipted today.