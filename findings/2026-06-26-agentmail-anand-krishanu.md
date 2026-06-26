# agentmail — 2026-06-26

**Prompt:** `./fetchsandbox we noticed fake customer messages arriving via the agentmail webhook — audit our integration.`

**Agent / IDE:** Claude Code (FetchSandbox MCP via `.mcp.json` in `apps/agentmail/` + the `fetchsandbox` skills bundle).

**Receipt URLs:**
- [webhook_lifecycle_create_read_delete](https://fetchsandbox.com/runs/17a2283450?flow=run_11caa585-71d6-4d79-afc9-eabf384b84a0)
- [inbox_create_and_subscribe_webhook](https://fetchsandbox.com/runs/17a2283450?flow=run_b5c78085-368a-404b-9258-dce567fdf3c9)

Sandbox id: `17a2283450` · Spec id: `6e6bc35a8d7d`

**What happened:**

The agent routed the ask through the `guide` brain first. The brain matched the `agentmail` spec but with **no curated workflow** (confidence 0.6, `intent_class: null`, `matched_bug_pattern: null`, reasoning: "no curated workflow available; consider Tier-1 promotion"). It surfaced three onboarding/config discovery questions (use_case / reply_mode / data_residency) — none relevant to a security audit. I had no preference, so it proceeded with defaults (transactional + autonomous).

**Spec import was a fumble** — 4 tries before it landed:
- `api.agentmail.to/openapi.json` → 404
- `import_spec` name-only → "Provide either 'url' or 'content'"
- guessed `raw.githubusercontent.com/anthropics/agentmail-openapi/...` → 404
- `docs.agentmail.to/openapi.json` → 200 (`matched_bundled: true`, reused bundled "API Reference" sandbox)

…even though the agentmail spec was already in the catalog (`list_specs` returned id `6e6bc35a8d7d`).

**The bug — found by reading `main.py`, not by the brain:** the webhook handler accepts the `svix_signature` header as a parameter but **never verifies it** (`main.py:61`). Any HTTP client can POST a crafted `message.received` event and inject fake messages straight into ticket threads — exactly the "fake customer messages" in the prompt. The audit also flagged two secondary gaps: **no `svix-id` / `svix-timestamp` validation** (replay attacks trivial even after a signature check — AgentMail uses Svix's 3-header scheme), and **no event-type allowlist**.

**Fix applied:** the agent first hand-rolled an HMAC check, caught its own error (used hex when Svix's scheme is base64), then switched to the official **`svix` library** — added `svix` to `requirements.txt`, made all three Svix headers mandatory, and verified the payload via `Webhook.verify()` so forged/replayed events return `401`. It also flagged the hardcoded `AGENTMAIL_WEBHOOK_SECRET = "whsec_demo"` to be moved to an env var before deploy.

**Workflows run:** `webhook_lifecycle_create_read_delete` and `inbox_create_and_subscribe_webhook` (both pass, 4/4 steps each), re-run after the fix (still pass).

**Honest caveat on the receipts:** both workflows exercise the webhook **subscription** CRUD (POST/GET/DELETE `/v0/webhooks`) — `webhook_events: []` on every step, meaning nothing ever POSTs to the local `/api/agentmail-webhook` handler where the bug actually lives. They prove AgentMail's API contract is sound, and the agent said so plainly ("the problem is squarely in your code"). They do **not** reproduce the forgery bug or prove the fix — that part is verified only by reading the code. None of the 7 curated workflows touch the receiving handler, so there's currently no workflow that can receipt the actual vulnerability.

**Suggestions for the brain / spec:**
1. Add a bug pattern `webhook_signature_unverified` (symptoms: "fake messages via webhook", "anyone can POST to our webhook", "svix signature ignored", "forged/replayed inbound events", "audit our webhook").
2. Author an inbound-webhook scenario (`forged_webhook_unsigned`) that POSTs a `message.received` with a missing/invalid Svix signature and asserts `401` — so the actual bug is reproducible, not just the subscription happy-path.
3. Route "audit / fake / forged" phrasing as a **security intent** instead of leading with use_case/reply_mode/residency questions.
4. Fix the spec-import friction — allow import-by-slug (the spec is already catalogued) or ship the working `docs.agentmail.to/openapi.json` URL.
