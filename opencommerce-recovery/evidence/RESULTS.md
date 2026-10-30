# Local Commerce SDK recovery proof — October 29, 2026

Application source `fd25cb996bfd1c9607175bbb24966a60bc467ffb`. SDK `@agent-cards/commerce-sdk@0.18.5`.
Engine `0aa39c90efcc92039e490854d8d352e69825301b`. **Historical local execution; not deployed; no hosted MCP receipt.**

The original measured application source is preserved at the public
[`proof-opencommerce-recovery-20261029` tag](https://github.com/fetchsandbox/playground/tree/proof-opencommerce-recovery-20261029/opencommerce-recovery).
The branch adds a public reproduction path; that does not retroactively change the recorded run.

## Observed application comparison

Healthy control: 13 passed. Deliberately defective reference: 7 passed, 6 failed.
Repaired reference: 13 passed. The contract and external controller hashes match
across all three legs. Existing FetchSandbox `proof_gate` admitted that local
measured failure-to-repair comparison. No Agentcard defect is alleged.

| Check | Expected behavior | Defective | Repaired | Defective observation | Repaired observation |
|---|---|---|---|---|---|
| same_worker_replay | Two deliveries to one worker yield one captured message | Passed | Passed | 1 captured; 1 sink attempts | 1 captured; 1 sink attempts |
| concurrent_workers | Concurrent first deliveries to two workers yield one captured message | Failed | Passed | 2 captured; 2 sink attempts | 1 captured; 1 sink attempts |
| restart_replay | An acknowledged completed event replayed after application restart yields one message | Failed | Passed | 2 captured; 2 sink attempts | 1 captured; 1 sink attempts |
| crash_after_inbox | After HTTP acknowledgment and SIGKILL before sending, restart delivers the durable pending event without webhook redelivery | Failed | Passed | 0 captured; 0 sink attempts | 1 captured; 1 sink attempts |
| crash_after_sink | SIGKILL after independent sink commit but before application acknowledgment recovers with one message | Passed | Passed | 1 captured; 1 sink attempts | 1 captured; 2 sink attempts |
| sink_failure | Sink returns 503 once; the durably accepted event is retried to one message | Failed | Passed | 0 captured; 1 sink attempts | 1 captured; 2 sink attempts |
| lost_sink_response | Sink commits then drops the HTTP response; retry retains one captured message | Failed | Passed | 1 captured; 1 sink attempts | 1 captured; 2 sink attempts |
| invalid_signature | SDK returns 400; no inbox or message effect | Passed | Passed | 0 captured; 0 sink attempts | 0 captured; 0 sink attempts |
| stale_signature | SDK returns 400 for signature timestamp 10 minutes old; no effect | Passed | Passed | 0 captured; 0 sink attempts | 0 captured; 0 sink attempts |
| expired_message | SDK returns 200 but expired purchase message produces no inbox or message effect | Passed | Passed | 0 captured; 0 sink attempts | 0 captured; 0 sink attempts |
| shopper_thread_isolation | Valid shopper/thread events go to their bound chats; mismatched binding produces no message | Passed | Passed | 3 captured; 3 sink attempts | 3 captured; 3 sink attempts |
| conflicting_event | Same event ID with changed payload delivered to another worker does not alter or repeat first message | Failed | Passed | 2 captured; 2 sink attempts | 1 captured; 1 sink attempts |
| database_failure_retry | Unavailable application database yields SDK 500; restored database plus redelivery captures one message | Passed | Passed | 1 captured; 1 sink attempts | 1 captured; 1 sink attempts |

## Evidence and controls

- [Comparison](2026-10-29/comparison.json), [contract](2026-10-29/contract.json), [summary](2026-10-29/summary.json).
- [Healthy receipt](2026-10-29/healthy/receipt.json), [defective receipt](2026-10-29/broken/receipt.json), [repaired receipt](2026-10-29/repaired/receipt.json).
- [Fresh-process readback and rejection controls](2026-10-29/fresh-process-readback.json): original evidence admitted; ten malformed/setup/isolation/cleanup variants refused.
- Three SDK contract preflights passed. Existing proof-gate regression: 37 passed, one pre-existing deprecation warning. These are separate from application execution and native-agent acceptance.
- Actual SIGKILL exit 137 observed at both interruption boundaries. Inbox and sink records were read independently with PostgreSQL queries. Restart recovery tests sent zero webhook redeliveries after restart.
- All three final legs removed their containers and networks. Final independent Docker listing found no `fsoc-` run resources. Built images/cache retained for reproduction.

## Failures retained

Attempt 1 hit PostgreSQL initialization readiness failures; the temporary Unix-socket
initialization server was not sufficient readiness. Controller now waits for final TCP readiness.
Attempt 2 then exposed an application defect: acquiring a database connection outside
`try/finally` left the outbox's draining flag stuck after a database outage. Its
repaired leg had 12 passing checks and one failure. We moved connection acquisition
inside `try/finally` and reran the same full contract in attempt 3. Prior attempts are
retained privately; they are not merged into this passing comparison.

## Limits and next acceptance

This tests our integration reference with actual unmodified SDK code and synthetic
signed events. No Agentcard API, real merchant, payment, shopper identity or live
mailbox was called. The sink is simulated delivery, not inbox proof. Exactly-one
captured notification depends on a sink that implements stable idempotency keys.
The JSON is local editable operator evidence, not a cryptographic attestation.

The production catalog read on October 29 returned HTTP 200 with no Agentcard or
OpenCommerce entry. No production MCP persona was launched, and no hosted receipt
is claimed. The next integration slice requires authorized Agentcard sandbox
credentials and actual provider events; live order/payment reconciliation needs
separate authoritative observations. No PR/approval/AWS release path is measured.
