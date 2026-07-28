# descope — scope escalation on exchange — 2026-07-23

**Prompt:** `./fetchsandbox test the flow end to end and check if there is bug fix it`

**Agent / IDE:** Claude Code (Sonnet 4.6), MCP via `.mcp.json` in `apps/descope/`.

**Receipt URLs:**
- before: https://fetchsandbox.com/runs/e0a579f709?flow=run_caf9dee3-fb45-44bc-9f64-ddf847baf1eb
- after: https://fetchsandbox.com/runs/e0a579f709?flow=run_bb5cfefe-5321-44ec-8335-0332d6e8dd5b

**What happened:**

Brain matched `scope_escalation_on_exchange` at 0.95 confidence. Picked workflow
`agentic_accesskey_exchange`. The bug was in `POST /api/agent/exchange` in `apps/descope/main.py`:
the handler copied caller-supplied `loginOptions.customClaims.scopes` directly into the minted
session JWT without checking them against the key's granted scopes. A `ak_readonly` agent (issued
only `users:read`) could request `users:write` in `loginOptions` and receive a token with that scope
— privilege escalation at exchange time.

Fix: clamp requested scopes against the key's grant before minting the token. Any scope in
`loginOptions.customClaims.scopes` not present in the key's issued set now returns HTTP 403
immediately. The happy path (no `loginOptions`, or valid scopes only) is unaffected.

The buggy/fixed reference diff confirmed: buggy handler returned `200` with elevated scopes; fixed
handler returned `403`. Real before/after submitted to the receipt via `submit_proof`.

Score: 9/10 — brain surfaced the exact code location and clamping fix pattern immediately. The
`check_for` items (`loginOptions.customClaims.scopes written unclamped`, `no intersection against
key's granted scopes`) mapped precisely to the two-line bug in the handler.
