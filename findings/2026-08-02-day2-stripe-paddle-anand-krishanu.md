# day 2 — planted bugs: stripe + paddle — 2026-08-02

**Prompt:** `./fetchsandbox something's off with this integration — investigate it, fix whatever is wrong, and prove the fix with a before and after.`

**Agent / IDE:** Claude Code (Opus 5), headless, cold session per app.

**Apps:** `apps/stripe`, `paddle/billing`, `paddle/entitlements`, `paddle/subscriptions`

**Receipt URLs:**
- stripe: https://fetchsandbox.com/runs/fbd931b872?flow=run_d3f24dbb-632e-45cd-bbea-171d4e0b08e7
- paddle/billing: https://fetchsandbox.com/runs/2efc62edd1?flow=run_ec8db9dd-a06f-4cd9-a758-5407389c9a65
- paddle/entitlements: https://fetchsandbox.com/runs/2efc62edd1?flow=run_1e939820-aa66-4251-ad3e-bdd64a0cb615
- paddle/subscriptions: https://fetchsandbox.com/runs/2efc62edd1?flow=run_6e60b5e9-9dae-45a5-9879-f537b1b4405d

## What happened

**4/4 found the real bug. All certified against source afterward:**

- **stripe `main.py:99-102`** — dedup keyed on the `stripe-webhook-id` *delivery* header, not `event["id"]`. Retries re-run the side effect. It also caught that the docstring at line 86 asserts the opposite of Stripe's real retry semantics — *"which is what hid the bug."*
- **paddle/billing** — no dedup at all; `provisionCount += 1` on every delivery.
- **paddle/entitlements `server.js:14` vs `:29`** — `subscription.created` sets `trialing`, the access gate allows only `active`. Every trial customer locked out for the whole trial.
- **paddle/subscriptions `server.js:15-17`** — `activated` arriving before `created` is silently dropped; paying customer gets 402.

**Best moment of the week:** `paddle/billing` proved on **real code** — started the actual Node server, POSTed the same `event_id` twice, observed `provisionCount: 2`, applied a dedup fix, re-ran, got `provisionCount: 1` and `"duplicate": true`. That is exactly the buggy-fails/fixed-passes bar.

## Issues

**S1 — `submit_proof` can never grade better than "self-reported", and its remediation is impossible to follow.**
`paddle/billing` genuinely ran real code and submitted a true before/after. Verdict: `proof_grade: "self_reported"`, `green_allowed: false`, `ran_real_code: false`, reason *"Provide probe_cmd + git refs to prove it on your code."*
I dumped the tool schema: `submit_proof` accepts exactly `sandbox_id, flow_run_id, bug_pattern_id, summary, proofs`. **There is no `probe_cmd` parameter and no git-ref parameter.** The grader demands fields the tool cannot accept — `green_allowed: true` is structurally unreachable through the MCP surface.

**S1 — "does the receipt change after the fix?" No.** Every receipt: `Assertions: 0`, `Failed/non-2xx: 0`, all 200s. The before/after lives entirely inside the `submit_proof` JSON payload the agent supplies. The page renders the same all-green timeline pre- and post-fix.

**S2 — stripe receipt URLs intermittently unreachable.** Returned **504**, then 200, 200, then a connection failure on retry. The day-1 stripe receipt also failed. Paddle/descope receipts were 200 throughout — specific to the large stripe sandbox.

**S3 — timeout error text names the wrong specs.** `paddle/entitlements` hit *"Large specs (Stripe, GitHub) sometimes take 10-15s on first import"* — while running Paddle.

**S3 — inconsistent `bug_pattern_id` for the same defect.** `paddle/billing` matched `notification_duplicate_side_effect` on day 1 and `notification_not_acknowledged` on day 2.

## Friction

Clean A/B on the day-1 structural point: the `paddle/` dirs have **no CLAUDE.md**, and those are exactly the runs where the agent executed real code. The `apps/*` dirs forbid it, and none of those runs did. The project rules are what block real-code proof.

**Proved before claiming? 4/4 Y.** stripe edited at tool call #11, after `run_workflow` + 3× `verify_behavior`. Stripe also volunteered: *"verify_behavior is timing out repeatedly… the proof on the receipt is my measured before/after (self-reported grade)."*

**Confidence: 3/5** — detection excellent, proof layer cannot issue a passing grade even when the proof is real.
