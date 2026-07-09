# stripe — 2026-06-23
## Prompt (verbatim from PROTOCOL.md)
> ./fetchsandbox we have a stripe webhook bug in prod — some payments are getting marked paid 2-3 times. fix it with proof.
## Tool-call sequence
1. FetchSandbox MCP consulted after stripping the ./fetchsandbox prefix.
2. Brain matched webhook_duplicate_side_effect.
3. Agent searched for YAML spec/config files.
4. Agent read project files and located the webhook implementation.
5. Agent called FetchSandbox to reproduce using accept_payment / webhook_retries.
6. Agent updated main.py to deduplicate on event["id"] instead of stripe-webhook-id.
7. Agent updated the webhook docstring to reflect the correct deduplication strategy.
8. Agent called FetchSandbox again to re-run validation after the fix.
## What the brain returned (if mcp__fetchsandbox__guide was called)
* spec: stripe
* workflow: accept_payment
* scenario: webhook_retries
* intent_class: debug
* bug_pattern matched: webhook_duplicate_side_effect
* confidence: Not surfaced to the user
## Receipt URLs surfaced
* before: None surfaced in session output
* after: None surfaced in session output
## What the agent identified as the bug
"main.py:99 was deduplicating on stripe-webhook-id — a per-delivery header that Stripe rotates on every retry. The same event['id'] arrived 2-3x with a fresh delivery ID each time, so every retry slipped through the dedup check and re-fired mark_order_paid."
## What the agent's fix was
* Replaced deduplication key from request.headers.get("stripe-webhook-id") to event["id"].
* Moved processed_webhook_ids.add(...) to occur after the side effect completes.
* Updated the webhook documentation to reflect event-id-based idempotency.
## Brain quality rating (1-10)
10/10
Justification:
The brain immediately classified the issue as webhook_duplicate_side_effect, directed the investigation toward the correct failure mode, reproduced the issue through the expected workflow, and the resulting fix closely matched the identified pattern. The agent relied heavily on FetchSandbox throughout the session.
## Did FetchSandbox earn its place in this session?
Yes
The MCP was consulted immediately, the brain matched the correct bug pattern, reproduction occurred through the sandbox workflow, and the final fix followed the identified failure pattern. The session would likely have taken significantly longer without the brain guidance.
## Specific suggestion for the brain.yaml for this spec
No new bug pattern required.
Existing pattern performed as expected.
Potential enhancement:
* id: webhook_dedup_persistence_limits
* symptoms:
  * "duplicate events after restart"
  * "idempotency lost after deployment"
  * "webhooks replay after server reboot"
  * "duplicate processing in multi-worker deployment"
* reproduce_with workflow + scenario:
  * workflow: accept_payment
  * scenario: webhook_retries
* check_for items:
  * dedup store survives process restart
  * dedup store shared across workers
  * unique constraint exists on event id
  * concurrent deliveries cannot bypass dedup logic
## What surprised you
The agent not only applied the expected event-id deduplication fix, but also highlighted two additional production risks (in-memory dedup storage and concurrent delivery races) that were outside the original bug report.
