# clerk-descope-agentmail — 2026-08-01

**date / hours:** 2026-08-01 / ~30 min

**tested today (specs / apps / flows):**
Acme HelpDesk (`apps/clerk-descope-agentmail`) — Clerk JWT customer auth, Descope access-key exchange, AgentMail inbox provisioning + reply; FetchSandbox spec `agentmail` / workflow `inbox_create_and_subscribe_webhook`

**Agent / IDE:** Claude Code (Sonnet 4.6 1M), MCP via `.mcp.json` in `apps/clerk-descope-agentmail/`

**Receipt URL:** https://fetchsandbox.com/runs/a5acf9ea32?flow=run_4afb9b2c-e80c-47f3-a7e1-e8f70ecdfc10

---

**worked well:**
- `guide` correctly identified `webhook_replay_attack_no_timestamp_check` on the AgentMail brain at confidence 0.95 once provider names were included in the prompt
- `quickrun` on `inbox_create_and_subscribe_webhook` passed all 4 steps cleanly in 66 ms
- `submit_proof` accepted a 5-probe before/after payload and attached it to the receipt without errors
- 5 planted bugs identified by static read of `main.py` and all fixed:
  1. `list_my_tickets` (L143): filtered `owner_id == email` instead of `owner_id == sub` → tickets always returned empty
  2. `get_ticket` (L156): ownership guard checked `agentmail_inbox_id != user_id` instead of `owner_id != user_id` → non-admins always 403
  3. `agent_reply` (L215): used `agentmail_address` (email string) as inbox path segment instead of `agentmail_inbox_id` → 502 on every reply
  4. `agent_update_status` (L247): hardcoded `"open"` instead of `body.status` → tickets could never be resolved
  5. `agentmail_webhook` (L286–291): `break` after first loop iteration routed all inbound messages to first ticket regardless of `inbox_id` match

---

**broke (one block per issue):**

- prompt i typed: `./fetchsandbox this is my app… can you run fetchsandbox to make some api calls and see where its breaking`
- spec / app: `guide` (first call)
- expected vs what happened: expected a matched spec; got confidence 0 and a triage question loop because no provider was named in the prompt — had to fire `guide` a second time with explicit provider names
- receipt URL: none
- severity: S3 minor

---

- prompt i typed: quickrun `agentmail` `inbox_create_and_subscribe_webhook` with scenario `replayed_old_signed_event`
- spec / app: `agentmail`
- expected vs what happened: `guide` returned `replayed_old_signed_event` in `matched_bug_pattern.reproduce_with.scenario`; `quickrun` rejected it — "Unknown scenario… Available: auth_failure, rate_limited" — the scenario exists in the brain's routing table but is not registered in the sandbox engine
- receipt URL: none (call failed)
- severity: S2 major

---

- prompt i typed: `verify_behavior` with `bug_pattern_id=webhook_replay_attack_no_timestamp_check` after quickrun
- spec / app: `agentmail`
- expected vs what happened: expected a side-by-side buggy/fixed diff on the receipt; got "bug_pattern has no simulation block" — cannot independently prove the pattern; proof is self-reported only
- receipt URL: https://fetchsandbox.com/runs/a5acf9ea32?flow=run_4afb9b2c-e80c-47f3-a7e1-e8f70ecdfc10
- severity: S2 major

---

**friction / confusing / slow:**
- Two `guide` calls needed for a vague provider-agnostic prompt — the `next_question` response is well structured but the extra round-trip adds latency; a lower confidence threshold that still returns top candidates would help
- `guide` response includes `reproduce_with.scenario` that `quickrun` silently doesn't support — contract mismatch between brain output and sandbox engine, no error until runtime

**did the agent PROVE before claiming a fix? (Y/N per task):**
- Webhook replay bug (webhook_replay_attack_no_timestamp_check): N — `verify_behavior` blocked by missing simulation block; self-reported proof only
- 5 code bugs in `main.py`: N — no live app run; proof submitted as self-reported before/after via `submit_proof`
