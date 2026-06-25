# resend — 2026-06-23

**Prompt:** `./fetchsandbox resend webhook handler may be silently dropping bounce events — users keep getting marked active even after they bounce. investigate and fix.`

**Agent / IDE:** Claude Code, MCP via `.mcp.json` in `apps/resend/`.

**Receipt URLs:** none — and this time the agent volunteered the gap before I asked. `import_spec` returned 8 workflows (`send_email`, `manage_contacts`, `domain_setup`, `domains_verified`, `broadcasts_sent`, …) but every one is an outbound Resend API journey; none POST an event at our own `/resend-webhook` handler, where the bug lives. So nothing in the sandbox could reproduce it. The agent could have run `send_email` and handed over a green "pass," but said outright that would only prove the send path, not the bounce branch — a misleading artifact, not proof — and refused. Sandbox id: `29b3775a94`. Spec id: `af671817633c`.

**What happened:**

The agent actually found the bug by reading `main.py` *before* the brain answered, then called `guide` per the convention.

Brain: spec `resend`, workflow `send_email` (Tier-1 default, not a real match), scenario none, intent_class `debug`, **bug_pattern null**, confidence 0.85. One matched signal was `failure_lang:bounce(unmatched)` — the brain saw "bounce" and flagged that it had nothing encoded for it. (PROTOCOL.md planted this as a deliberate "no bug_patterns yet" day.)

Bug: the webhook handler only branches on `email.delivered` — no branch for `email.bounced` or `email.complained` — so a bounced user's `email_status` stays `"active"` forever. The docstring even admitted "that's the only event we currently handle." A dead address keeps reading as a healthy, active user and we keep emailing it.

Fix: look the user up once, then branch on event type — `email.delivered` records `last_delivery_at` (as before); `email.bounced` sets `email_status = "bounced"`; `email.complained` sets `email_status = "complained"`. No tests, no `.venv`, no sandbox run. The whole fix came from reading the file, not the brain.

**Brain rating: 4/10.** Routing was fine, and the honest `null` / `bounce(unmatched)` signals are what kept the agent from faking a receipt — so it wasn't useless. But that's all it gave: no fix pattern, no scenario, and the workflow it pointed at (`send_email`) is unrelated to the bug. Better than a session where the brain never gets called; worse than Stripe (7/10), where it actually named the bug and handed over the fix.

**Earned its place? Partial.** Called early, and its honest "I've got nothing for bounce" steered the agent away from a fake green receipt. But it couldn't reproduce or fix the bug — none of the Resend workflows touch the webhook. This session ran two house rules straight into each other: "proof must be a FetchSandbox receipt" + "no local test files" leave no legal way to verify an inbound-webhook fix. The agent flagged the clash rather than quietly breaking a rule.

**Suggestion for brain.yaml:** add pattern `bounce_complaint_silent_drop` (symptoms: "users bouncing but staying active," "bounce events silently dropped," "complaint webhook ignored," "email_status never leaves active after a bounce," "we keep sending to addresses that already bounced"). The real gap is reproduce_with: workflow `send_email` + scenario `bounced_email` **which doesn't exist yet** — all 8 workflows are outbound, so a pattern alone won't earn a receipt until there's an inbound-webhook workflow that delivers an `email.bounced` payload to `/resend-webhook`. check_for: branches on `email.bounced`/`email.complained` (not just delivered); user record updated on bounce/complaint; re-send to a bounced/complained address blocked downstream; the `svix-signature` header actually verified (it's read on the route and never checked — a second, quieter bug right next door).

**Surprised me:** the agent called the brain and still couldn't earn a receipt, and instead of running `send_email` for a green link that proves nothing, it stopped and said out loud that the two house rules can't both be satisfied here. The honest read isn't "the brain is missing a pattern" — it's that no Resend workflow touches the webhook at all, so there's nothing to reproduce against.
