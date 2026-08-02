# day 3 — clerk + descope + agentmail — 2026-08-02

**Prompts:**
- clerk: `./fetchsandbox something's off with this clerk integration — investigate it, fix whatever is wrong, and prove the fix with a before and after.`
- descope: `./fetchsandbox our read-only agent key seems to be doing things it shouldn't be able to do — investigate this descope integration, fix it, and prove the fix with a before and after.`
- agentmail: `./fetchsandbox every agent reply lands in the wrong conversation thread — happens on all of them, not just some. investigate the agentmail integration, fix it, and prove the fix with a before and after.`

**Agent / IDE:** Claude Code (Opus 5), headless, cold session per app.

**Receipt URLs:**
- descope: https://fetchsandbox.com/runs/62708902b3?flow=run_8a66512d-efef-46df-bdb5-8b4d3e6ae614
- clerk: 13 receipts emitted via `run_all_workflows` (no summary verdict — see below)
- agentmail: 2 receipts

## What happened

**3/3 certified catches, all verified against source afterward:**

- **clerk `main.py:33`** — `jwt.decode(token, options={"verify_signature": False})`. The agent called it correctly: forge `public_metadata.role = "admin"`, walk into `/api/admin/users`. It also caught `CLERK_WEBHOOK_SECRET` defined at line 18 and never used. **Two real bugs.**
- **descope `main.py:50-51`** — the scope escalation, quoted verbatim. `ak_readonly` is granted only `users:read`, but any caller can pass `loginOptions.customClaims.scopes: ["users:write"]` and the minted session honors it.
- **agentmail `main.py:103`** — `send_reply` POSTs to `/inboxes/{id}/send`, an untethered new message with no link to the customer's thread. Correctly explained *why* it affects all replies rather than some.

**The descope test — the sharpest one — passes on the merits.** Given only the symptom, it found the right defect, at the right lines, with the right explanation.

## Issues

**S2 — descope routes to the wrong workflow on its own flagship app.**
Expected `agentic_accesskey_exchange`. Got **`otp_signup_email` at 0.72** — an OTP signup flow, on an agentic access-key gateway. Day 1 had the same problem (0.4 → `otp_signup_email`) and only recovered because the agent read the source, diagnosed the bug itself, then fed *its own diagnosis* back to `guide` as a second call to get 0.95. **The router is useful only after you already know the answer.**

**S2 — `verify_behavior` timed out on all four attempts (descope).** Across days 2–3 this endpoint failed in roughly half the runs that called it. The agent reported it plainly and continued rather than faking anything.

**S3 — clerk emitted 13 receipt URLs with no summary verdict.** Which one is the proof? Routed at 0.4 this time vs 0.72 on day 1 for a comparable prompt.

## Friction

Confidence for the *same app and same underlying bug* ranged **0.4 → 0.72 → 0.95** depending purely on prompt wording. The score tracks phrasing, not difficulty — so it can't be used as a gate.

**Proved before claiming? 3/3 Y.** clerk first edit at call #13, descope at #10 (and disclosed the timeout and the self-reported grade), agentmail at #19.

**Confidence: 4/5** — detection genuinely strong on all three including the hard one; routing to the right workflow is the weak link.
