# descope (Agent Gateway) — 2026-07-23

**Prompt:** `./fetchsandbox something's off with this descope integration — investigate it, fix whatever is wrong, and prove it.`

**Agent / IDE:** Claude Code (Opus 4.8), MCP via `.mcp.json` in `apps/descope/`. Went in cold — did not read `main.py` before the run.

**Receipt URLs:** https://fetchsandbox.com/runs/e0a579f709?flow=run_0afb184d-25b9-472a-98ad-83b7cfa584c2

**Score: 7/10** — first descope session to produce a real receipt. Held back by
a confidently-wrong first route, a green `quickrun` on buggy code, and a brain
that retrieved the bug pattern only after the agent had already diagnosed it.

---

## Outcome

It found the real bug and the fix is correct.

`apps/descope/main.py:50-51` derived session scopes from client input:

```python
requested = ((body.loginOptions or {}).get("customClaims") or {}).get("scopes")
scopes = requested if requested else rec["scopes"]
```

`ak_readonly` could request `["users:write"]` and receive a signed session JWT
carrying it. The gate at `main.py:82` checks the session claims — which the
caller controlled — so a read-only agent key could create users.

Applied fix (intersect, never widen):

```python
granted = rec["scopes"]
requested = ((body.loginOptions or {}).get("customClaims") or {}).get("scopes")
scopes = [s for s in requested if s in granted] if requested else list(granted)
```

## Biggest win vs 2026-07-10

The previous descope report got **zero** receipts across two sessions, blocked
on `import_spec` requiring a public Descope OpenAPI URL that doesn't exist, and
on a `coach` intake loop that never advanced.

`quickrun` and `verify_behavior` bypass that wall completely — no `import_spec`,
no spec URL, straight to a receipt. That was the single blocking issue in the
last report and it is now gone. The receipt renders, shows the probe table, and
states its own limits.

## The brain did not find the bug

Sequence actually observed:

1. `guide(<raw user prompt>)` → workflow `otp_signup_email`,
   `matched_bug_pattern: null`, **confidence 0.85**, plus 2 triage questions.
2. Agent ignored that, read `main.py` and `README.md` itself, located the defect.
3. `guide(<intent string containing the full diagnosis>)` → `accesskey_overscoped`,
   **confidence 0.95**.

The brain pattern-matched a description the agent handed it. Confidence rose
because the input improved, not because the brain contributed.

Worth cross-referencing: in `findings/2026-07-10-descope-ajit.md` the prompt
*also* pre-contained the hypothesis ("might be handing out more scope than the
key was granted") and scored 0.85. Across two testers and three sessions, the
brain has not located this bug from a cold prompt. Retrieval-given-the-answer is
strong; diagnosis-from-cold is unproven.

## Bugs / rough edges

**1. First route is confidently wrong.**
`otp_signup_email` is the flow belonging to `apps/descope-onboarding`. This app
is access-key exchange and has no OTP anywhere. The response's own `reasoning`
says "routed to its Tier-1 **default** workflow" and `matched_bug_pattern` is
`null` — yet `confidence` is **0.85**. A declared fallback should score low; a
high number on a fallback is the one thing a confidence score exists to prevent.
A less stubborn agent runs an OTP workflow against an app with no OTP.

**2. `quickrun` returned `"status": "pass"` (3/3 steps, 37.8ms) on the still-buggy code.**
It ran *before* the fix was applied. The `agentic_accesskey_exchange` workflow
does not exercise the escalation path, so the "reproduce" step reproduced
nothing. Per TESTING.md's own checklist — "did it reproduce what it claims is
wrong?" — no.

**3. The probes model a cousin of the bug, not the bug.**
Probe: `POST /v1/mgmt/tenant/user` with `Authorization: Bearer ak_readonly` —
raw access key as bearer, no exchange step — with `assert_buggy.note` reading
"route never checks the key's scope."

The real app *does* check scope at `main.py:82`. The defect is upstream: the
exchange mints a JWT carrying attacker-supplied scopes, so the gate validates a
claim the caller wrote. Same class and the same fix advice, but a different
mechanism, and the probes never touch `/api/agent/exchange`. The
`fix_pattern` string ("Never derive scope from client input") is what actually
earns the match — the probes don't.

**4. Routes on the receipt don't correspond to the app.**
Receipt shows `/v1/auth/accesskey/exchange`, `/v1/auth/me`,
`/v1/mgmt/tenant/user`. The app under test exposes `/api/agent/exchange`,
`/api/agent/whoami`, `/api/tenant/users`. Correct Descope API routes, but
nothing a reader can tie back to this codebase except via the disclaimer.

**5. Receipt rendering vs probe semantics.**
The probe named "read-write access key writes (sanity)" renders on the receipt
page as a duplicate/"201 (ignored)" row. The page appears to be describing
duplicate-suppression where the probe intended a sanity check. Worth eyeballing.

**6. Design contradiction: the strongest proof is unreachable by project rule.**
`submit_proof` is the only route to a receipt about *the user's own code*, and
it requires the app running. `apps/descope/CLAUDE.md` forbids venvs, pytest, and
local test files. The rules make the best artifact impossible to produce. Either
relax the rule for the proof step, or give `submit_proof` a path that doesn't
need a live process.

## What's genuinely good — keep this

The `disclaimer` on `verify_behavior` is prominent, accurate, and repeated on the
receipt page: reference handlers, **NOT your code**. The agent surfaced it
unprompted instead of passing the green receipt off as proof of the codebase, and
explicitly declined to fabricate `submit_proof` counters when it couldn't measure
them.

That restraint is the most trustworthy thing in the run. Most tools would have
let the checkmark speak. Don't sand it down.

## Note for maintainers

The scope fix above is left **uncommitted** in this PR on purpose — committing it
would unplant the bug for the next tester. Only this findings file is included.
