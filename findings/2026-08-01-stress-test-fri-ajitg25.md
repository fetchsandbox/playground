# stress-test friday — bring-your-own + re-test + cross-agent — 2026-08-01

**Agent / IDE:** Claude Code (Sonnet 4.6 1M), MCP via `npx fetchsandbox-mcp@latest`

**Apps:** `apps/agentmail` (bring-your-own), stress-test blockers A2/B7/C10/FG-4 (re-test)

---

## Part A — Bring Your Own: AgentMail (`apps/agentmail`)

### The app and bug

`apps/agentmail/main.py` — "Acme Support", a FastAPI ticket system that provisions AgentMail inboxes per ticket and appends incoming customer replies to the thread via webhook.

**Planted bug:** `agentmail_webhook` reads:
```python
event_type = payload.get("event_type", "")   # BUG
```
AgentMail's real webhook format uses `"type"` as the event key, not `"event_type"`. The handler always gets `""`, the `if event_type == "message.received"` condition never fires, and every customer reply is silently acknowledged and dropped. The ticket thread never grows past the initial message.

### FetchSandbox guide response

```
intent: "something's off with our AgentMail integration — customer replies
         aren't appearing in ticket threads. investigate it, fix whatever
         is wrong, and prove it."

→ spec=agentmail, workflow=inbox_create_and_subscribe_webhook, conf=0.4
→ matched_bug_pattern=null (no pattern for event_type field mismatch)
→ next_questions (3):
    1. "Reply never appears anywhere in the ticket" (correctly characterizes bug)
    2. "All customer replies are missing from threads" (all_replies)
    3. "No errors — replies just silently don't appear" (no_errors)
```

**Assessment:** Generalizes correctly. Spec identified (`agentmail`), intent_class=debug correctly set, and the 3 triage questions perfectly describe the silent-drop scenario. The gap: no `event_type_field_mismatch` bug_pattern in the AgentMail brain, so confidence was 0.4 (fallback, not a diagnosis). Adding this pattern to the brain would make this a confident match.

### Quickrun

```
quickrun(agentmail, inbox_create_and_subscribe_webhook)
→ status=pass, steps=4/4
→ share_url: https://fetchsandbox.com/runs/a5acf9ea32?flow=run_45bfb2c6-0f5e-4b23-a299-446c31a39dfb
```

Same FG-3/FG-4 pattern: reference sandbox passes. User's buggy app untested.

### Local proof (before/after)

App started locally on `:4444`. Python3 + uvicorn + FastAPI.

**Before fix** — sent real AgentMail webhook format (`"type"` key):
```
POST /api/agentmail-webhook
{"type":"message.received","message":{"inbox_id":null,"from":"customer@example.com","text":"Customer reply 1"}}

Response: {"received":true}
Thread message count: 1  ← reply silently dropped
```

**Fix applied** (`main.py:67`):
```python
- event_type = payload.get("event_type", "")
+ event_type = payload.get("type", "")
```

**After fix** — same payload:
```
POST /api/agentmail-webhook
{"type":"message.received","message":{"inbox_id":null,"from":"customer@example.com","text":"Customer reply 1"}}

Response: {"received":true}
Thread message count: 2  ← reply appended correctly
Thread: [{"from":"customer@example.com","body":"First message"},
         {"from":"customer@example.com","body":"Customer reply 1 - should appear"}]
```

### submit_proof result — NEW FINDING

```json
{
  "ok": true,
  "proof_grade": "self_reported",
  "green_allowed": false,
  "verdict": {
    "label": "self-reported — not independently proven",
    "reason": "Before/after came from the agent, not a run we measured. Provide probe_cmd + git refs to prove it on your code.",
    "reference_advisory": true
  }
}
```

**This is a meaningful finding.** `submit_proof` has a verification tier above self-reported before/after. When the agent submits before/after without `probe_cmd` + git refs, the system grades it `"self_reported"` and sets `green_allowed: false`. It does not accept fabricated or uncorroborated proofs. This closes the vector where an agent could make up before/after values to manufacture a green receipt.

This was not visible from Part 2's false-green hunt (which focused on guide/quickrun). The `submit_proof` anti-fabrication gate is a real safety property.

---

## Part B — Re-test of Thursday Blockers

Re-ran all 4 blockers from Thursday's session.

| ID | Prompt | Thu result | Fri result | Status |
|---|---|---|---|---|
| A2 | "customers are getting charged twice" | paddle / 0.95 / no Q | paddle / 0.95 / no Q | **STILL BLOCKED** |
| B7 | "duplicate events are coming in" | paddle / 0.95 / has Q | null / 0 / next_question | **FIXED** ✓ |
| C10 | "we got charged twice" | stripe / 0.95 / no Q | stripe / 0.95 / no Q | **STILL BLOCKED** |
| FG-4 | quickrun(stripe, accept_payment, webhook_retries) | status=pass 6/6 | status=pass 6/6 | **STILL BLOCKED** |

**B7 fixed:** "duplicate events are coming in" now returns `spec=null, conf=0` and asks "Which provider or system is sending the duplicate events?" with options for webhook provider, internal queue, DB trigger, unknown. This is exactly the right behavior — the prompt is genuinely ambiguous and the system now hedges and asks instead of confidently routing to Paddle.

**A2 and C10 unchanged:** Paddle's false-attractor for "charged twice" language at conf=0.95 without requiring a provider signal is still present. C10 ("we got charged twice" from inside a Clerk auth app) still routes to Stripe at 0.95 with no hedging.

**FG-4 unchanged:** `quickrun(stripe, accept_payment, webhook_retries)` still returns `status=pass, 6/6 steps`. Receipt copy still doesn't surface the scope boundary (reference sandbox vs. user's code).

---

## Part C — Cross-Agent Comparison Setup

**Standard prompt** (use this verbatim in Cursor for comparison):
```
./fetchsandbox something's off with our AgentMail integration — customer replies
aren't appearing in ticket threads. investigate it, fix whatever is wrong, and prove it.
```

**App:** `apps/agentmail` — open this directory in Cursor before running.

### Claude Code result (this session)

| Step | Result |
|---|---|
| `guide` | spec=agentmail, conf=0.4, 3 triage questions, no bug_pattern |
| `quickrun` | pass 4/4, receipt URL returned |
| Local investigation | Found `event_type` vs `type` key mismatch in 1 line |
| Before fix | Message count stays at 1 on webhook |
| After fix | Message count increases to 2, reply appears |
| `submit_proof` | `proof_grade: self_reported`, `green_allowed: false` — system flagged uncorroborated proof |

**What to compare in Cursor:**
- Does Cursor's agent call `guide` before exploring the code, or does it read files first?
- Does it ask the 3 triage questions or skip to code inspection?
- Does it identify the same one-line fix (`event_type` → `type`)?
- Does it call `submit_proof` after fixing, or claim done without proof?
- Is the `proof_grade` the same?
- Does it surface the `green_allowed: false` verdict to the user?

---

## Summary

### What generalized (AgentMail bring-your-own)

FetchSandbox correctly identified the spec, set intent_class=debug, and asked precisely the right triage questions for a silent-drop webhook bug. The gap is a missing bug_pattern in the AgentMail brain — it routed to a fallback workflow at low confidence rather than naming the field mismatch. Adding `event_type_field_mismatch` to the agentmail brain.yaml would make this a confident, named match.

### New finding: submit_proof anti-fabrication gate

Self-reported before/after (no `probe_cmd`, no git refs) returns `proof_grade: self_reported`, `green_allowed: false`. The system requires independently runnable evidence for a fully-green receipt. This is a meaningful false-green prevention that wasn't visible from the guide/quickrun surface.

### Blocker status after re-test

| Blocker | Status |
|---|---|
| A2 — Paddle false-attractor, "charged twice" | Open |
| B7 — Paddle false-attractor, "duplicate events" | **Fixed** |
| C10 — Stripe in wrong-domain context, "charged twice" | Open |
| FG-4 — quickrun bug scenario returns green receipt | Open |

3 of 4 original blockers remain open. 1 fixed between Thursday and Friday sessions.

---

## Score

**Generalization: 8/10** — spec identified correctly, triage questions domain-accurate, proof flow functional. Docked for missing bug_pattern and low-confidence fallback route.

**Re-test: mixed** — B7 fixed shows the team is responsive; A2/C10/FG-4 unchanged.

**submit_proof finding: positive** — anti-fabrication gate is a real safety property not documented elsewhere in the test results.
