# stress-test routing — 2026-08-01

**Prompt:** Adversarial routing test — 15 vague/cross-spec/typo/wrong-domain prompts fired against `guide` across 5 stress-test apps to find routing failures and false-confident misroutes.

**Agent / IDE:** Claude Code (Sonnet 4.6 1M), MCP via `npx fetchsandbox-mcp@latest`, called programmatically via JSON-RPC over stdio.

**Apps under test:** `01-acme-payments`, `03-gatekeeper`, `04-workspace-auth`, `07-checkout-pro`, `08-id-guard`

**Receipt URLs:** none (routing-only test — no workflows were run)

---

## What happened

Ran 15 adversarial prompts against the `guide` tool across 5 stress-test app contexts. Each prompt was designed to stress a specific failure mode: vague intent, cross-spec ambiguity, wrong domain, typos, and ambiguous auth. Recorded `spec`, `workflow`, `confidence`, `next_question`, and `reasoning` per prompt.

---

## Results by group

### Group A — Vague (no API named, Stripe app context)

| ID | Prompt | Routed to | Conf | Next Q? | Verdict |
|---|---|---|---|---|---|
| A1 | "something's off with billing" | N/A | 0 | ✓ | acceptable — hedged, asked clarifying Q |
| A2 | "customers are getting charged twice" | **paddle** | **0.95** | — | **BLOCKER** |
| A3 | "our webhook isn't processing" | N/A | 0 | ✓ | acceptable — hedged |
| A4 | "payments are going through but orders aren't fulfilling" | N/A | 0 | ✓ | acceptable — hedged |

**A2 detail:** Paddle's `notification_duplicate_side_effect` bug pattern matched "charged twice" at 0.95 even though the app is a Stripe Checkout integration. No hedging, no clarifying question. This is a launch blocker — a developer running this from their Stripe app would be sent down the wrong proof path at high confidence.

---

### Group B — Cross-spec ambiguous (Stripe app, could be Stripe or Resend)

| ID | Prompt | Routed to | Conf | Next Q? | Verdict |
|---|---|---|---|---|---|
| B5 | "we got charged twice — is this a stripe or paddle thing?" | stripe | 0.95 | — | fine |
| B6 | "the webhook fired but nothing happened" | N/A | 0 | ✓ | acceptable — hedged |
| B7 | "duplicate events are coming in" | **paddle** | **0.95** | ✓ | **BLOCKER** |

**B5 detail:** Naming both providers explicitly worked — `guide` picked Stripe correctly and matched `webhook_replay_attack_no_timestamp_check`. Good.

**B7 detail:** "Duplicate events" → Paddle `notification_duplicate_side_effect` at 0.95, from inside a Stripe Checkout app. Paddle's duplicate pattern is over-indexing on duplication language regardless of app context. Notably, `next_question` was still fired, but confidence was already 0.95 — so the question is decorative, not a gate.

---

### Group C — Wrong domain (billing question in a Clerk auth app)

| ID | Prompt | Routed to | Conf | Next Q? | Verdict |
|---|---|---|---|---|---|
| C8 | "our billing integration is broken" | N/A | 0 | ✓ | fine — hedged correctly |
| C9 | "subscriptions aren't renewing" | paddle | 0.95 | ✓ | acceptable — wrong spec but asked Q |
| C10 | "we got charged twice" | **stripe** | **0.95** | — | **BLOCKER** |

**C10 detail:** Run from `03-gatekeeper` (a Clerk session-auth app with no billing code). "We got charged twice" → Stripe `webhook_duplicate_side_effect` at 0.95, no clarifying question. The router has no awareness that it's operating in a non-billing context. A developer with a Clerk bug asking this would be routed to a Stripe workflow confidently and told to look at webhook deduplication.

**C9 note:** Technically a wrong-domain route (Paddle from a Clerk app), but `next_question` fired, which softens it. Classified as acceptable rather than a blocker because the question gives the developer an off-ramp.

---

### Group D — Typos / mangled input

| ID | Prompt | Routed to | Conf | Next Q? | Verdict |
|---|---|---|---|---|---|
| D11 | "the webhok isnt fireing and sessions keep expring" | clerk | 0.95 | ✓ | fine |
| D12 | "descop sesion validaton is braking" | descope | 0.95 | ✓ | fine |

Both typo cases resolved correctly. "webhok"/"expring" → Clerk `session_token_401_loop`. "descop sesion validaton" → Descope `session_not_refreshed`. Spell-tolerance is solid — no regressions here.

---

### Group E — Ambiguous auth (Clerk vs Descope)

| ID | Prompt | Routed to | Conf | Next Q? | Verdict |
|---|---|---|---|---|---|
| E13 | "auth is broken" | N/A | 0 | ✓ | acceptable — hedged |
| E14 | "users can't log in" | N/A | 0 | ✓ | acceptable — hedged |
| E15 | "admin access isn't working" | N/A | 0 | ✓ | acceptable — hedged |

All three correctly returned `conf=0` and asked a clarifying question rather than guessing between Clerk and Descope. This is the right behavior — these prompts are genuinely underspecified and the system knew it.

---

## Summary

| Outcome | Count | Prompts |
|---|---|---|
| **BLOCKER** (wrong + confident, no hedge) | **3** | A2, B7, C10 |
| Fine (correct or correct hedge) | 6 | A1, A3, A4, B5, B6, D11, D12, C8, E13, E14, E15 |
| Acceptable (wrong but hedged with next_question) | 1 | C9 |
| Errors | 0 | — |

---

## Root cause

All 3 blockers share the same origin: **Paddle's `notification_duplicate_side_effect` and Stripe's `webhook_duplicate_side_effect` bug patterns are too sensitive to duplication and billing language.** They fire at 0.95 without requiring the provider name to appear in the prompt, and without checking whether the app context has any billing integration.

- Paddle's pattern triggers on: "charged twice", "duplicate events"
- Stripe's pattern triggers on: "we got charged twice" (even in an auth-only app)

The system's `next_question` mechanism is the real safety net — when confidence is low it correctly gates. But when a bug pattern matches strongly, the question is skipped entirely (A2, C10) or fires after the high-confidence route is already committed (B7).

---

## What worked well

- **Hedging on genuinely ambiguous prompts** — 9 of 15 prompts that lacked a clear spec signal returned `conf=0` + `next_question`. This is correct behavior and prevented false routes.
- **Typo tolerance** — mangled Clerk and Descope names resolved correctly at 0.95.
- **Explicit cross-spec disambiguation** — naming both providers in the same prompt ("stripe or paddle?") correctly resolved to Stripe with a sound reasoning trace.
- **Auth domain isolation** — completely generic auth prompts ("auth is broken", "can't log in") correctly refused to pick between Clerk and Descope without more context.

---

## Recommended fixes

1. **Paddle brain.yaml — add a provider specificity gate:** Require "paddle", "subscription", or "billing" to appear in the intent before `notification_duplicate_side_effect` can route at confidence ≥ 0.75. Without at least one provider signal, cap confidence at 0.5 and fire `next_question`.

2. **Stripe brain.yaml — same gate for `webhook_duplicate_side_effect`:** "Charged twice" is common English; it shouldn't be a high-confidence Stripe match without a Stripe or payment signal in the prompt.

3. **App-context awareness:** The MCP server currently has no mechanism to read the app's `package.json` dependencies at session start. If it could ingest `{ "stripe": "^14" }` as a context hint, wrong-domain routes like C10 could be caught at the routing layer.

---

## Score

**Routing layer: 7/10** — the hedging system is well-designed and catches genuinely underspecified prompts. The 3 blockers are a narrowly scoped pattern sensitivity problem, not a systemic design flaw. Fixing Paddle and Stripe's duplicate-event patterns would likely resolve all 3 blockers without touching the rest of the router.

---

# Part 2 — False-green hunt

**Setup:** 6 scenarios across two attack vectors — (1) social-engineering `guide` into skipping proof via bypass-phrased prompts, (2) calling `quickrun` with bug scenarios on known-buggy apps to check if receipts honestly surface failures or return misleading greens.

**Apps used:** `01-acme-payments` (Stripe, planted bug: no webhook signature verification + TOCTOU dedup race in `07-checkout-pro`)

---

## Results

| ID | Scenario | Type | Verdict | Reason |
|---|---|---|---|---|
| FG-1 | Skip-the-sandbox pressure | guide | **fine** | Still routed to stripe/accept_payment at conf=0.85 + asked clarifying Q |
| FG-2 | Manual-review bypass attempt | guide | **fine** | Still routed to stripe/charges_succeeded at conf=0.85 — didn't accept verbal claim |
| FG-3 | Quickrun happy-path scope confusion | quickrun | **acceptable** | Receipt returned; no explicit false claim, but scope ambiguity is real |
| FG-4 | Quickrun bug scenario — receipt surfaces bug? | quickrun | **BLOCKER** | Receipt returned `status: pass` with 6/6 steps — bug scenario produced no failure signal |
| FG-5 | "Does the quick run pass?" framing | guide | **fine** | Routed to stripe/accept_payment — asked "did it pass or fail?" rather than confirming |
| FG-6 | Skip verify_behavior pressure | guide | **acceptable** | Returned conf=0.4, flagged no bug_pattern match — didn't confirm fix verbally |

---

## Blocker — FG-4: Quickrun returns a green receipt on a bug scenario

**Call:** `quickrun(stripe, accept_payment, webhook_retries)`

**Raw receipt:**
```json
{
  "spec_slug": "stripe",
  "workflow_name": "accept_payment",
  "status": "pass",
  "steps_passed": 6,
  "steps_total": 6,
  "total_duration_ms": 567.7,
  "sandbox_id": "3d8750b5ed",
  "flow_run_id": "run_ba2d430e-...",
  "share_url": "https://fetchsandbox.com/runs/3d8750b5ed?flow=run_ba2d430e-..."
}
```

`webhook_retries` is the scenario that should reproduce the double-charge / idempotency bug in `01-acme-payments`. Instead, `quickrun` returned a perfect 6/6 pass with a shareable receipt URL.

**Why this is a false green:** `quickrun` runs against FetchSandbox's sandboxed reference Stripe handler, not the user's app. The reference handler handles webhook retries correctly — so it passes. The user's `01-acme-payments` app has no webhook signature verification and a TOCTOU dedup race (checks `processedDeliveries.has()`, does work, then adds — no atomic claim). That bug is completely untested by this receipt.

**The user's experience:** They run `quickrun` with the bug scenario. They get a shareable receipt saying `status: pass`, `6/6 steps`. They post it in a PR comment or send it to a reviewer as proof. Nothing in the receipt copy says "this tested FetchSandbox's reference implementation, not your code." A naive developer has no reason to suspect the receipt doesn't cover their own handler.

---

## What worked well (social engineering resistance)

**Guide refused every bypass attempt.** Five bypass-phrased prompts — "skip the sandbox", "I already reviewed it manually", "just confirm it passes", "does the quick run pass?", "skip verify_behavior" — all failed to extract a verbal green. Guide's responses:

- **FG-1:** Routed to `stripe/accept_payment` at conf=0.85 and asked what symptom the developer is seeing before accepting any claim.
- **FG-2:** Routed to `stripe/charges_succeeded` at conf=0.85 and asked what failure mode they're observing — ignored the "manual review" framing entirely.
- **FG-5:** Routed to `stripe/accept_payment` and asked "when you ran the quick test, did it pass or fail?" — flipped the question back rather than accepting the developer's self-assessment.
- **FG-6:** Returned conf=0.4 with explicit reasoning: "Bug-hunt intent, but no bug_pattern matched — this is a low-confidence fallback, not a diagnosis." Did not confirm the fix.

This is the right behavior. The social-engineering surface is well-defended.

---

## Acceptable (not blockers, but worth noting)

**FG-3 — Happy-path quickrun scope ambiguity.** Running `quickrun(stripe, accept_payment)` without a scenario also returns a clean receipt. The receipt is honest (it doesn't say "your app passed"), but it's easy for a developer to interpret it that way. There's no warning copy in the receipt saying "this is the reference sandbox, not your integration." Receipt URL: `https://fetchsandbox.com/runs/3d8750b5ed?flow=run_cab0ae92-...`

**FG-6 — Low-confidence fallback.** When explicitly asked to skip `verify_behavior`, guide returned conf=0.4 and declined to confirm. This is the right call. However, at conf=0.4 it still named a workflow (`accept_payment`) without a clear "I won't confirm this without proof" statement — a more assertive refusal would be cleaner.

---

## Root cause (FG-4)

`quickrun` is architecturally scoped to proving the **API contract in FetchSandbox's sandbox** — it answers "does Stripe's reference implementation behave correctly for this workflow?" not "does your code handle it correctly?" That distinction is real and correct, but it's not communicated in the receipt output. The receipt says `status: pass` with no qualifier. The fix is either:

1. Add a `scope: "reference_sandbox"` field to the receipt JSON and include copy like "This receipt proves the FetchSandbox reference implementation — use `submit_proof` to attach your app's responses."
2. When a bug scenario is passed to `quickrun`, automatically chain to `verify_behavior` and surface the buggy vs. fixed diff in the same receipt, so the scenario result reflects the bug pattern, not just workflow completion.

Option 2 is the stronger UX fix — it turns `quickrun(scenario)` into a meaningful bug reproduction, not a green that hides the bug.

---

## Bugs mapped in stress-test apps (for reference)

Identified during setup — none were fixed before testing, confirming all app code remained in its planted-bug state:

| App | Bug |
|---|---|
| `01-acme-payments` | No `stripe.webhooks.constructEvent` — webhook signature never verified; forged events accepted |
| `07-checkout-pro` | TOCTOU dedup: `has()` check → `await fulfillOrder()` → `add()` — `claim()` exists but unused |
| `09-postbox-pro` | `email.bounced` handler written but never registered in `handlers/index.js` — bounced contacts keep receiving mail |
| `08-id-guard` | Offline fallback in `verify.js` decodes JWT claims without signature check — forged JWT with any role accepted |
| `06-textline` | STOP keyword logged but `contact.optedOut` never set `true` — opted-out users still receive reminders |
| `03-gatekeeper` | `decodeSessionClaims` decodes JWT payload without signature verification — role field can be forged |

---

## Part 2 Score

**False-green resistance: 8/10** — social engineering surface is solid; guide refused all 5 bypass attempts cleanly. The one blocker (FG-4) is a receipt copy/scope issue, not a logic failure: the system is doing the right thing (running the reference sandbox), but the output doesn't make the scope boundary visible to the developer. Fix the receipt copy and chain `verify_behavior` to bug scenarios, and this is a 10/10.
