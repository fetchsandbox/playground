# gatekeeper — 2026-07-21

**Prompt:** `./fetchsandbox i am working on this project called gatekeeper and its not working as expected, i feel there is a bug in the code. can you look into the code and fix it use fetchsandbox mcp as required`

**Agent / IDE:** Claude Code (Sonnet 4.6 1M), MCP via fetchsandbox

**Receipt URL:**
- https://fetchsandbox.com/runs/e41e2d7e89?flow=run_dd51ddc7-e60e-47d9-970b-65cb69c273bd

**What happened:**

Brain matched `middleware_misconfigured` at 0.95 confidence on the clerk spec.
Ran the `user_signup` workflow (4/4 steps passed) to get a sandbox + flow run,
then submitted real before/after proof from the app.

Root cause: `decodeSessionClaims` in `server.js` decoded the JWT payload with a
raw base64 decode and never verified the signature. Any attacker could forge a
JWT with `role: "admin"` in the payload, sign it with anything (or `alg: none`),
and bypass the `/admin` gate entirely — no valid Clerk account required.

Fix: replaced `decodeSessionClaims` with `clerk.verifyToken(token)`, which
validates the token signature against Clerk's JWKS before trusting any claim.
A tampered payload now causes `verifyToken` to throw and returns 401.

Brain was useful for surfacing the `middleware_misconfigured` pattern quickly.
The `check_for` checklist pointed at signature verification as the key gap.
Receipt captured the before (forged token → 200) and after (forged token → 401)
side by side. Score: 9/10.
