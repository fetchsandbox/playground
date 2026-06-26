# agentmail — 2026-06-27

**Prompt:** `./fetchsandbox we noticed fake customer messages arriving via the agentmail webhook — audit our integration.`

**Agent / IDE:** Claude Code (FetchSandbox MCP via `.mcp.json` in `apps/agentmail/`).

**Rating: 6/10** — found and fixed the real bug correctly, but the receipts don't actually reproduce or prove it, and spec import + brain routing were rough.

**Receipt URLs:**
- [run 17a2283450 — webhook contract proof](https://fetchsandbox.com/runs/17a2283450)

Sandbox id: `17a2283450` · Spec id: `6e6bc35a8d7d`

**What happened:**

Brain matched the `agentmail` spec at 0.6 confidence, no curated workflow, and led with onboarding questions (use_case / reply_mode / residency) irrelevant to a security audit — proceeded on defaults. Spec import took two tries (a guessed GitHub raw URL 404'd; `docs.agentmail.to/openapi.json` worked) even though the spec was already catalogued.

**The bug** (found by reading code, not the brain): `/api/agentmail-webhook` declared `svix_signature` but never checked it, and `AGENTMAIL_WEBHOOK_SECRET` was unused. Any POST with `message.received` + a valid `inbox_id` got appended to the ticket thread — anyone with the URL can inject fake customer messages.

**Fix:** raw-body + official `svix` lib — `Webhook(SECRET).verify(...)`, `401` on failure (`main.py:69`). Flagged: add `svix` to requirements; move the hardcoded secret/key to env vars.

**Workflows:** `inbox_create_and_subscribe_webhook` + `webhook_lifecycle_create_read_delete`, both 4/4, re-run after fix.

**Caveat:** every step shows `webhook_events: []` — nothing hits the local handler where the bug lives. The receipts prove the subscription contract, not the forgery fix; that's verified by code read only. "Before" and "after" point at the same timeline.

**Suggestions:** add a `webhook_signature_unverified` bug pattern; author a `forged_webhook_unsigned` scenario that POSTs an unsigned event and asserts `401`; route "audit/forged" as a security intent; allow spec import-by-slug.
