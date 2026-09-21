# descope (agentic auth) — 2026-07-24

**Prompt:** `./fetchsandbox go to descope app and do task 2 is find the planted bug`

**Agent / IDE:** opencode (deepseek-v4-flash-free)

**Receipt URLs:**
- Agentic access-key exchange happy path: https://fetchsandbox.com/runs/e0a579f709?flow=run_eee34bbf-64f3-4c63-be7c-2aa2d5fd8625

**What happened:**

Called `guide` with the full prompt. Resolved to `spec=descope`, `workflow=agentic_accesskey_exchange` at confidence 0.85. `intent_class=debug`, matched bug pattern `scope_escalation_on_exchange` via memory_graph at confidence 0.85.

`quickrun` of the happy path passed 3/3 steps. Then called `verify_behavior` with `bug_pattern_id=scope_escalation_on_exchange`:

- **Probe:** POST `/v1/auth/accesskey/exchange` with `ak_readonly` key + `loginOptions.customClaims.scopes: ["users:write"]`
- **Buggy handler:** → **200** (scope escalation succeeds — scopes honored verbatim)
- **Fixed handler:** → **403** (scope exceeds key grant — refused)
- **Verdict:** `"Pattern confirmed — buggy returned 200, fixed returned 403"`

**Planted bug location:** `apps/descope/main.py:50-51` — the exchange endpoint copies `loginOptions.customClaims.scopes` from the client into the minted session without clamping to the key's granted scopes. An `ak_readonly` key can self-escalate to `users:write`.

**Fix applied:** Clamp requested scopes to the intersection with the key's granted set; raise 403 if any requested scope exceeds the grant.

**Score:** 10/10 — guide found the exact bug via memory_graph, verify_behavior confirmed it with buggy/fixed diff, fix was applied.