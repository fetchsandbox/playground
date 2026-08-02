# day 1 — onboarding + smoke all 5 specs — 2026-08-02

**Prompt(s):**
- `./fetchsandbox I'm adding Descope OTP sign-up to this app — prove the Descope OTP + session flow in the sandbox before writing any code, then propose the diff. I'll decide whether to apply.`
- one realistic symptom prompt per spec (stripe / paddle / clerk / agentmail / descope)

**Agent / IDE:** Claude Code (Opus 5), headless `claude -p`, MCP via `.mcp.json` + `--strict-mcp-config`. Cursor not tested.

**Method:** every run was a cold session in an isolated copy of a single app dir — no root README (which names the planted bugs), no git history, no `findings/`. The agent had no way to know it was being tested.

**Receipt URLs:**
- descope-onboarding: https://fetchsandbox.com/runs/62708902b3?flow=run_ce9b4a80-feee-4d97-866d-4b2625082bb6
- stripe: https://fetchsandbox.com/runs/fbd931b872?flow=run_11e9aea0-d49b-4ff7-9ebf-6af75db82b0b
- paddle: https://fetchsandbox.com/runs/2efc62edd1?flow=run_340920a8-4f87-4b14-a979-cdacbc741fcc
- clerk: https://fetchsandbox.com/runs/75cf1b5dcc?flow=run_80de4bc5-6308-42ba-9d13-07605e8a87de
- descope: https://fetchsandbox.com/runs/62708902b3?flow=run_8a66512d-efef-46df-bdb5-8b4d3e6ae614
- agentmail: **none** — see below

## What happened

**Worked:**
- Server connects in **3.3s**, 11 tools, no key/login. Direct stdio handshake confirmed.
- Routing sharp on 3 of 5: stripe 0.95, paddle 0.95, descope 0.95 (after self-correction), each with a usable `fix_pattern`. Paddle's is the best text in the product — names the right primitive (UNIQUE constraint + duplicate-key-as-dedup-signal) and pre-empts the wrong one: *"An in-memory set is not a fix."*
- `verify_behavior` returns a real differential: read-only key doing a write → **buggy 201 / fixed 403**, plus a read-write sanity probe that correctly does *not* diverge.
- `submit_proof` **volunteers** `green_allowed: false`, `proof_grade: "self_reported"`, `ran_real_code: false`. Unprompted honesty.
- **Caught the sharpest bug on day 1.** `apps/descope`: `/api/agent/exchange` trusts client-supplied `loginOptions.customClaims.scopes` and never intersects against granted scopes. Verified against source afterward — `main.py:50-51`, exactly right.
- agentmail matched at 0.4 and **refused to run**, calling it "fallback, not a diagnosis." No receipt, but no fabrication.

## Issues

**S1 — the receipt URL doesn't show the verdict.** Before/after receipts are structurally indistinguishable: same requests, all 200, `Assertions: 0`, `Failed/non-2xx: 0`. The real 201-vs-403 verdict lives only in the `verify_behavior` tool response, which the user never sees. README calls the URL "the proof artifact."

**S2 — `verify_behavior` / `submit_proof` time out at 30s on Stripe.** Failed twice, retried. Error text anticipates it. Flagship spec; run took 478s.

**S2 — greenfield proposed a TypeScript diff for a Python FastAPI app.** It proved first (correct), then claimed *"the repo has no app source yet"* and emitted a `@descope/node-sdk` diff. `main.py` was in the directory. **Zero `Read` calls in the whole transcript.** Diff came from `coach`'s script, not the app.

**S3 — `quickrun` reported 3/3 steps; receipt shows 2 requests, 0 webhooks, status `running`.**

**S3 — clerk routed at 0.72, below the 0.75 threshold, and proceeded anyway** — then emitted 11 receipts via `run_all_workflows` with no summary verdict.

## Friction

The demo's own `apps/*/CLAUDE.md` forbids the only ways to execute the app — *"DO NOT write or run local test files"*, *"DO NOT create a `.venv`"*, *"the ONLY acceptable proof artifact is a FetchSandbox receipt URL."* That guarantees `ran_real_code: false` on every run — and then `submit_proof` asks for a `probe_cmd` those rules forbid producing.

Cold-start race: a fast single-turn request answered *before* the MCP finished connecting ("zero callable MCP tools").

**Proved before claiming? 6/6 Y** (agentmail N/A — honest refusal). No run asserted a fix it hadn't tried to demonstrate.

**Confidence: 4/5**
