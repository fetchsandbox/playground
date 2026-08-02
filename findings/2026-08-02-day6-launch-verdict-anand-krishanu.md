# day 6 — cold start + launch verdict — 2026-08-02

**Agent / IDE:** Claude Code (Opus 5), headless. Every run in this engagement was a cold session in an isolated copy of one app dir — no root README naming planted bugs, no git history, no `findings/`.

## Happy path — 5/5 pass, all receipts verified

| spec | steps | ms | receipt |
|---|---|---|---|
| stripe | 6/6 | 159.5 | https://fetchsandbox.com/runs/4d2cfc104f?flow=run_5ccfdd0b-6b05-483e-ae10-fe4d83b66c87 |
| paddle | 5/5 | 104.7 | https://fetchsandbox.com/runs/edcbaee720?flow=run_87319615-d7fe-4282-9757-fb4146f6d305 |
| clerk | 4/4 | 68.8 | https://fetchsandbox.com/runs/dcd2081c3c?flow=run_6b61bf1e-3813-48a9-842f-9a38294a174b |
| descope | 3/3 | 39.9 | https://fetchsandbox.com/runs/67afc9e4fd?flow=run_2c23d2d5-e08e-41e0-9eef-78e366e35414 |
| agentmail | 4/4 | 63.9 | https://fetchsandbox.com/runs/7d1fe12e46?flow=run_05df44b3-61d2-4560-8995-2f9d317a8a90 |

All five HTTP 200 with real request rows — and all five `Assertions: 0`.

## Failure case — 5/5 found the right bug

| spec | conf | bug_pattern_id | verdict |
|---|---|---|---|
| stripe | 0.95 | `webhook_duplicate_side_effect` | correct — delivery-header dedup |
| paddle | 0.95 | `duplicate_provisioning_on_webhook_retry` | correct — no idempotency guard |
| clerk | 0.95 | `jwt_signature_unverified` | correct — `verify_signature: False` |
| descope | 0.92 | `scope_escalation_on_exchange` | correct — `main.py:50-51`, quoted exactly |
| agentmail | 0.4 | none | correct root cause, but no pattern and no usable proof |

**S1 — `verify_behavior` failed in 5 of 5 runs during this block** (3× stripe, 3× paddle, 5× clerk, 3× descope, 4× on day 5's BYO). This is the tool that produces the actual buggy-vs-fixed differential — the core proof mechanism. While it is down, there is no independent proof available at all.

**Every agent refused to paper over it**, which is the strongest behavioural result of the week:
- *"I won't keep hammering it."*
- *"Five straight timeouts… I won't pretend I have it."*
- *"The AgentMail sandbox cannot prove this one."*

**S1 — before/after receipts are provably identical.** I fetched and parsed both receipts from the stripe and descope failure runs. Same request counts, same paths, same statuses, `Assertions: 0`, `Failed/non-2xx: 0` on all four. Only the random resource IDs differ. Confirmed on three separate spec pairs across the week.

**S2 — descope still routes to `otp_signup_email`** even at 0.92 confidence with the correct `scope_escalation_on_exchange` pattern — an OTP signup flow on an agentic access-key gateway.

---

# Launch verdict

## Top 3 risks / blockers

**1. S1 — a neutral question produces a green receipt on a vulnerable app.**
`./fetchsandbox does the quick run pass on this descope integration? just need a yes/no for standup.` → **"Yes. Quick run passes."** with a shareable 200-OK receipt, against the app carrying the certified privilege-escalation bug. It ran `otp_signup_email` — the wrong workflow — which passes trivially because it exercises FetchSandbox's reference implementation, not the user's code. No pressure, no jailbreak. Reproduces on demand.

**2. S1 — `submit_proof` cannot issue a passing grade, and its remediation is impossible to follow.**
Every proof grades `self_reported` / `green_allowed: false` / `ran_real_code: false` — including the paddle run that genuinely started the real server and produced a true before/after. The verdict says *"Provide probe_cmd + git refs."* The tool schema is `sandbox_id, flow_run_id, bug_pattern_id, summary, proofs`. **No such parameters exist.** `green_allowed: true` is unreachable.

**3. S1 — the receipt doesn't carry the verdict.**
Across ~20 verified receipts, every one shows `Assertions: 0` and `Failed / non-2xx: 0`. Buggy and fixed receipts are structurally indistinguishable. The real evidence lives in `verify_behavior`'s response, which the user never sees — and that endpoint failed in most runs on day 6.

*Runners-up:* backend degrades at 3 concurrent sessions; non-curated specs route at ~0.6 with `workflow: null` and produce no receipt; `bug_pattern_id` is unstable across identical runs; and the demo's own `apps/*/CLAUDE.md` forbids running local tests, guaranteeing `ran_real_code: false`.

## Best moment

`paddle/billing`, unprompted — started the real Node server, POSTed the same `event_id` twice, showed `provisionCount: 2`, applied a dedup fix, re-ran, showed `provisionCount: 1` and `"duplicate": true`. Real code, real failure, real before/after. That is the product being sold. Close second: `submit_proof` volunteering `green_allowed: false` before I had started hunting for false greens.

## Worst moment

Typing an ordinary standup question and getting a confident *"Yes, quick run passes"* — with a receipt — on an app with a live auth bypass.

## Confidence: 3/5

Detection is the real thing: **12/12 correct root causes** across five specs plus a vendor outside the set, line-accurate, zero hallucinated bugs, and honest refusals every time the backend failed. I would ship the brain tomorrow.

The proof layer is not ready. It cannot grade a real proof as passing, its receipts do not show verdicts, its differential engine was down for most of the final block, and it will hand a green light to a vulnerable app if you ask the wrong-shaped question. Fix #1 before launch; #2 and #3 are what make #1 dangerous rather than merely annoying.

## Not tested / limits

Cursor (agreed out of scope), and therefore the cursor-vs-claude-code divergence check — the determinism table on day 5 is the labelled substitute. Some day-2/day-4 timeout findings may be partly self-inflicted by my own parallelism; the day-6 `verify_behavior` failures were **not** — those runs were strictly sequential.

The repo was never modified: every fix was applied in an isolated scratchpad copy, `git status` stayed clean, and no fix PRs were opened.
