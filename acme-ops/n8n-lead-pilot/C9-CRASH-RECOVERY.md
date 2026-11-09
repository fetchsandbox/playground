# C9: abandoned claims and process crashes

**Calendar/Slack recovery candidate published; full C9 matrix remains open.**
Native candidate `5e260355-bfba-43f9-9a67-fb11509d4de3` adds positive Calendar
and Slack read-back. The latest measured native result is recorded at the end of
this document. Backend `f7eeee67` is unchanged.
The earlier native `bc0acc3f` 15-passed/C9-unmeasured receipt is historical evidence.
C9 is still typed unmeasured in the unchanged, frozen FetchSandbox contract. Its historical blocker wording remains byte-for-byte preserved; this document records the newer implementation and bounded native results. No new engine receipt
or native builder acceptance follows from the local tests. Native attempts are recorded separately below.

## User journey and acceptance owner

The app builder inspects this workflow and proposes the expected recovery contract.
The existing FetchSandbox MCP runner freezes it, issues protected twin bindings,
executes the published n8n trigger, polls the same run and independently checks
provider effects. The runner owns actual process restart when its maintained
`client_checkpoint` lifecycle requests it. Native Code nodes own business decisions;
the adapter owns conditional storage and bounded provider transport.

A native crash check must witness the accepted provider write and abandoned
checkpoint, kill the real adapter process, retain its shared storage and bindings,
restart it, then inspect saved identities and independent provider effects. A
successful process restart between completed actions alone does not establish the
accepted-write/before-checkpoint failure. The existing lifecycle supports restart. The separately added `C9_deal_crash`
experiment below targets the accepted-write boundary; the full native C9 matrix
remains unqualified.

## Implementation

- `LeadState` adds server-owned, renewable leases and claim epochs using the existing
  `KvStore.create/replace` conditional writes. One worker can take an expired claim;
  competing takeovers lose the compare-and-swap. Foreign requesters cannot take it.
- Every save and provider dispatch checks owner, version and lease. Provider dispatch
  performs a conditional write, replacing the earlier read-then-dispatch race. The
  adapter carries the resulting version forward without overwriting temporary
  read-back candidates in the decision machine.
- An interrupted `in_flight` operation becomes `unknown` on recovery. Positive,
  identity-checked Contact/Deal/Gmail reads can confirm it. An empty lookup does not
  authorize another create/send. An already-issued HTTP request may still finish
  late; a lease does not recall it or make a third-party API transactional.
- Slack intent is saved before sending. A crash after possible acceptance leaves
  an unknown notification; recovery does not resend the same uncertain outcome.
  A later, different business outcome can have its own notification.
- `STATE_TABLE` selects the existing `DynamoStore`. The existing proof runner passes
  `PILOT_STATE_TABLE` and optional `PILOT_DYNAMODB_ENDPOINT` to that adapter. Endpoint
  overrides are restricted to loopback DynamoDB Local. FileStore remains the default
  for older local proofs and is **not** safe for independent processes sharing a file.
  Real AWS use requires a pre-existing table, normal SDK credentials/region and
  separate qualification; no AWS resources were created by these tests.
- Lease expiry is based on application wall clocks. Clock skew and database/region
  outages need explicit qualification. The safety fallback is an unknown outcome,
  never a claim of exactly-once provider execution.

The design follows conditional-write ownership and explicit retry intent, rather
than treating timeouts as failed writes. References:
[AWS conditional writes/optimistic locking](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/BestPractices_OptimisticLocking.html),
[AWS retry/idempotency guidance](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/).

## Local evidence and failures retained

The unchanged baseline passed 528 tests. Five new tests failed on the original
implementation and passed after the fix. The first process experiment passed four
cases and failed Deal recovery: replacing the entire working state at lease renewal
lost the temporary read-back ID. The adapter now updates only the trusted renewed
version/epoch/deadline. The failing log is retained, not counted as a pass.

Final command, with a disposable loopback DynamoDB Local endpoint:

```sh
C9_DYNAMODB_ENDPOINT=http://127.0.0.1:YOUR_PORT npm test
npm run check
node n8n-lead-pilot/build-adapter.mjs /private/c9-adapter.mjs
```

Final full suite: **543 passed, zero skipped**, across 76 files. TypeScript and the
adapter bundle passed. This includes five local recovery tests, nine DynamoDB/HTTP
fixture process tests, and one actual adapter HTTP/DynamoDB restart test. Without
`C9_DYNAMODB_ENDPOINT`, the ten service-dependent tests are explicitly skipped;
that invocation must not be reported as crash-test evidence.

The process tests use the real decision machine, real conditional store, independent
Node processes, actual SIGKILL, and a recording HTTP fixture. The fixture is not a
live provider or FetchSandbox twin. DynamoDB Local image is pinned to
`amazon/dynamodb-local@sha256:6ada631ec7aa5fc83446855eb17233e3dad184fec47477e8140c6c569cfe0c86`.
The database stays running between worker crashes; database crash/restore was not tested.

| Measured local case | Observed result |
|---|---|
| Crash after Contact accepted, before checkpoint | Positive email/ID read-back; one Contact and one of each subsequent effect |
| Crash after Deal accepted, before checkpoint | Positive relationship/ID read-back; one Deal, no duplicate downstream effects |
| Crash after Gmail accepted, before checkpoint | Exact Message-ID/recipient/SENT read-back; one message and Calendar event |
| Crash after Calendar accepted, before checkpoint | One recorded event; saved unknown; no second Calendar create. Automatic reconciliation remains missing |
| Crash after Slack accepted, before checkpoint | One recorded notification; saved unknown; no blind resend. Automatic reconciliation remains missing |
| Two independent replacement processes | One replacement won; one set of effects |
| Old process paused before dispatch, then resumed after takeover | Old dispatch denied; no Contact/Deal effect |
| Old request commits late after replacement's empty read-back | Replacement paused unknown; original Contact committed once; no blind retry or downstream Deal |
| Registered `blind-deal-retry` source variant after crash | Two distinct Deals; the same one-Deal business oracle rejected it |
| Actual authenticated adapter with DynamoDB | Claim remained identical after SIGKILL/restart; foreign requester denied; no provider traffic |

These tests do not cover every instruction, checkpoint, event schedule or outage.
Logs and sanitized hashes are in [local evidence](evidence/c9-local/observation.json).
The controlled broken workflow is rejected by the business oracle; the test that
expects that rejection passes. This is not a new failing FetchSandbox receipt.

## Remaining milestones

1. Qualify Calendar and Slack positive reconciliation, or explicitly agree that
   unknown/manual reconciliation is the required business outcome. Do not silently
   change the original full-flow success requirements to count a hold as completion.
2. Publish a separately identified native candidate and capture its actual export.
   The previous export must fail the new source guard; do not relabel it.
3. Add reviewed C9 actions through the existing contract/lifecycle owner, retaining
   every other requirement. Witness actual accepted effects and crash boundaries,
   restart with the same shared store, and measure stale-owner and independent counts.
4. Run native negative controls, three clean full-contract repetitions and fresh
   independent builder-agent acceptance. Keep all failures and unmeasured cases visible.

The local milestone performed no customer contact or backend deployment. The later
November 9 native publication and qualification are recorded separately below.
The full native C9 milestone remains open.

A documentation edit to the frozen C9 blocker changed its hash and configuration byte count; two contract-identity gates rejected it. The entire contract was restored unchanged rather than repinning those gates. The failed metadata check is retained separately.


## Native fault-injection candidate, November 9

Native workflow `PJlTC5gnf6wb0r8e` now publishes recovery candidate
`4db33f75-d11f-4c1c-89e4-5247b2bc9a40`; actual downloaded export SHA256
`92efc7cf8703825689986b5ea10aebd7e10297b45115071a19b9ed3aff123e5e`.
Its six nodes and wiring pass the exact source guard. The prior export is rejected.
This publication alone does not prove crash recovery. Production backend remains
`f7eeee67`; no backend rollout is part of this experiment.

`PILOT_CONTRACT=crash` adds `C9_deal_crash` through the existing MCP runner.
It preserves every prior oracle (including the identity overlay) and leaves the
original C9 matrix blocked. The added check is a single Deal boundary, not all
crash points or all upstream services.

The fault mechanism is deliberately outside the application:

1. `runtime-crash-preload.mjs` calls the real twin HTTP request unchanged. For one
   explicitly selected test Deal, it pauses after receiving a successful response
   with an ID, before returning that response to application code.
2. The parent independently reads the owner management twin state and the saved
   application checkpoint. It must observe exactly that accepted Deal and a still
   `in_flight` operation without a checkpointed ID. A child message alone is not proof.
3. `runtime-crash.mjs` sends SIGKILL only to its owned adapter child and records the
   actual exit signal. It restarts the same bundle with the same bindings and
   still-running DynamoDB table, then records a different PID.
4. The normal n8n workflow waits for the 30-second lease to expire, takes over the
   abandoned claim and positively reads the Deal back. The verifier checks saved
   epoch 2, original Contact identity, associated Deal identity and independent
   counts for Contact, Deal, Gmail, Calendar and Slack. Replaying must not add effects.
5. `crash-observation.json` is separate OS/witness evidence. The public business
   receipt alone does not attest the SIGKILL. `runtime_fault_qualified` stays false
   unless the controller completes its independent witness, kill and restart.

No synthetic success response, scenario-ID branch in business code, public crash
endpoint, or live customer service is used. The injected pause is one scheduling
point; it does not exhaust every possible crash/interleaving.
The killed process is the privately owned adapter, not an n8n Cloud SaaS worker.
The native execution loses its I/O connection and errors, then a new native
execution performs recovery. Native worker-host termination, database loss and
regional failure are not measured by this experiment.

The managed relay carries verifier-to-adapter requests. The existing protected
ngrok connection separately carries n8n Cloud-to-adapter I/O; these are different
network boundaries.

Local validation for this harness candidate: 544 application tests passed with
zero skips and DynamoDB Local enabled; TypeScript and adapter bundle passed.
Six Node harness/startup tests passed, including refusal to count a crash without
an independent witness and refusal to trigger on a wrong nonce. Cloud receipts,
negative-control qualification and the full C9 matrix remain separate milestones.


The first November 9 native attempt stopped before execution: the application
contract validator rejected a single 35-second delay (`delivery delay must be
positive and at most 5 seconds`). The next candidate uses seven five-second
waits, retaining the same lease-expiry interval. That setup failure is retained
and is not a passing run. An authoring review also replaced an impossible ID
reference to the crashed request with a separate persisted-checkpoint GET; no
historical contract or oracle was weakened.


The first executed cloud candidate (`4db33f75`) recorded an independently witnessed
Deal acceptance, checkpoint gap, SIGKILL and replacement PID, but its receipt
[failed](https://fetchsandbox.com/runs/e02020e438?flow=vr_525f4dff43c8483d9109292cf04523ae):
12 held, four violated, original C9 unmeasured. C3, C3_recovery and C5 exposed a
regression from suppressing new held-outcome notifications after an already
confirmed notification. The correction permits a new attempt's report after a
confirmed send, while keeping uncertain prior dispatches held without resending.
The frozen C3/C5 oracles remain unchanged.

The new Deal-crash check also incorrectly inherited C2's expectation that the
interrupted request had sent an `unknown` Slack message. A real process death
prevents that notification. Its separately versioned C9-specific oracle now
requires zero such messages and exactly one final confirmed message, while
retaining all business identities, associations and effect counts. This is a
new-crash-case contract correction, not same-contract before/after evidence for C9.

Corrected native candidate `7e773eaa-45bf-4dad-a4e2-7fab28d62251` has actual export
SHA256 `a717d8b8ac60967634d0868a6ea32f76556973f427a6da042da432023866f7d5`.
The native Save dialog initially left the earlier downloaded file in place; the
source guard rejected that stale export before traffic. After saving the actual
new file, the exact source guard accepted it. Corrected local suite: 545 passed,
zero skips, including a new confirmed-notification regression test. Native
requalification remains a separate receipt.


## Earlier bounded native Deal result

[Corrected receipt](https://fetchsandbox.com/runs/fb889cd736?flow=vr_e71e27e84f0d47cebc38851537caee09):
**16 held, zero violated, original C9 unmeasured**. Overall verdict is
**inconclusive**, `app_verified=false`, `complete=false`; strict runner exit is 1.
`C9_deal_crash` held, as did the unchanged C3/C3_recovery/C5 oracles. The OS-side
controller independently qualified the actual crash. Backend `/api/build` was
read again and reported `f7eeee67`; no backend rollout was performed.

Accepted Deal `352519583086` was independently witnessed before checkpoint;
owned adapter PID `66794` exited by SIGKILL, and replacement PID `78777` started.
Native execution 468 lost its I/O connection; execution 469 recovered with epoch
2, the identical accepted Deal ID and positive read-back. Independent provider
oracles held for exactly one Contact, associated Deal, Gmail message, Calendar
item and final Slack confirmation, including replay. These are isolated twins,
not live vendor effects.

Keep the [business receipt](evidence/c9-native/corrected-receipt.json) and
[OS/witness record](evidence/c9-native/corrected-crash-observation.json) separate.
[Observation and limitations](evidence/c9-native/observation.json) records exact
versions and scope. [The failed receipt](evidence/c9-native/failed-receipt.json)
and its own crash record remain separate; none of its failed checks is counted
as a pass. [Contract parity](evidence/c9-native/contract-parity.json) confirms all
16 earlier check definitions stayed exactly unchanged between native attempts.

Reproduction uses the existing runner and private credential handoff, not a second
verifier. After saving an actual published native export that passes the source
guard, starting the existing protected reverse connection and preparing a
loopback DynamoDB Local table:

```sh
PILOT_CONTRACT=crash \
N8N_WORKFLOW_EXPORT=/private/actual-native-export.json \
PILOT_BINDINGS_SOURCE=/private/existing-pilot-bindings.json \
PILOT_STATE_TABLE=your-disposable-local-table \
PILOT_DYNAMODB_ENDPOINT=http://127.0.0.1:YOUR_PORT \
PROOF_BUNDLE=dist/lead-pilot-c9.mjs PROOF_PORT=8097 \
PROOF_OUT_DIR=/private/new-proof-directory \
node verify/relay-proof.mjs n8n-lead-recovery
```

Use the configured FetchSandbox account credential privately; never put it in
source, chat, native inline headers or receipt artifacts. Keep the table running
across the crash. The runner must see both the accepted provider ID and the
missing checkpoint before it kills its owned process. Missing witness, restart,
provider counts or identities remains failure/unmeasured, never a pass.

The full C9 matrix, native negative control, three clean native repeats, fresh
builder acceptance and live vendor parity remain open. The one passing Deal
boundary does not close those milestones.


## Calendar and Slack recovery extension, November 9

Native candidate `5e260355-bfba-43f9-9a67-fb11509d4de3` has actual export
SHA256 `58bc4cbc2cfa1ddedf3c8f628994eda24a8b01f763f232f9c7e1ce8396f32ffd`.
The source guard accepts its six nodes/wiring and rejects the prior `7e773eaa`
export. Publication alone does not establish recovery.

Provider qualification through MCP-issued twins found Calendar event listing
unsupported (HTTP 501). Client-assigned event creation and reading that exact ID
both returned 200. The workflow now saves a deterministic, provider-valid event
ID before dispatch. Recovery reads only that ID and requires the exact summary,
confirmed status, attendee and interval before confirming it. Absent or mismatched
read-back keeps the action unknown without creating another event. This does not
claim that Calendar listing is supported.

Slack history returned the posted text/timestamp. Recovery uses the fixed pilot
channel and bounded history read. It requires a complete page and exactly one
matching message not already recorded as a prior accepted notification. Missing,
ambiguous, paginated, wrong-channel or wrong-text results remain unknown without
a resend. Confirmed responses must contain a timestamp. Already-confirmed status
updates on a new held attempt retain the original business contract. This is a
bounded controlled-channel test, not universal exactly-once Slack delivery.

Local evidence: 567 tests passed, zero skipped, with DynamoDB Local enabled;
TypeScript passed. Seven separate crash/start harness checks passed, including
actual accepted HTTP ID and timestamp interception before SIGKILL. The two new
Calendar/Slack process recovery expectations failed on the earlier machine. An
intermediate Calendar fixture omitted the confirmed status returned by the twin;
that failure is retained separately and the fixture now reflects the qualified
response. Sixteen contract gates preserve all original check oracles, keep original
C9 unmeasured, and bound the three added fault targets/configuration size.

`PILOT_CONTRACT=crash` now adds `C9_calendar_crash` and `C9_slack_crash` alongside
the original bounded Deal experiment. Each has its own accepted-effect witness,
owned adapter SIGKILL, replacement PID, lease takeover, exact identity read-back
and independent five-provider counts, including replay. They share a business
receipt but retain three distinct OS/witness files. Neither a public receipt nor
a child IPC message alone establishes the actual process death.

The native outcome below qualifies the three bounded cases. The original C9 matrix, native
negative controls, three clean repetitions, fresh builder acceptance, native n8n
worker-host death, real AWS database loss/restore and live vendor parity remain
unmeasured. DynamoDB Local remains running across the adapter crashes.


### Native Calendar/Slack result

[Separate receipt](https://fetchsandbox.com/runs/ee47e36e23?flow=vr_b855f8217c1a41c29a62dbb802f00a9d):
**18 held, zero violated, original C9 unmeasured**. All 85 recorded independent
provider-state assertions held. Overall remains **inconclusive**, `app_verified=false`,
`complete=false`, strict runner exit 1. The three accepted-write crash controllers
finished independently and `runtime_fault_qualified=true`. Backend `/api/build`
still reports `f7eeee67`; only the isolated n8n pilot was republished.

| Bounded case | Actual SIGKILL/replacement | Native execution/recovery | Observed result |
|---|---|---|---|
| Deal control | 70512 → 71162 | 504 errored → 505 succeeded | Exact accepted Deal `035771482891` recovered; epoch 2 |
| Calendar | 71162 → 71305 | 507 errored → 508 succeeded | Exact preselected/accepted event ID recovered; positive read-back; epoch 2 |
| Slack | 71305 → 71470 | 510 errored → 511 succeeded | Accepted timestamp `17MY1HTCN0.TLE5G9` recovered; positive read-back; epoch 2 |

Each case retained exactly one Contact, associated Deal, Gmail message, Calendar
event and final Slack confirmation after recovery and replay. The native crash
executions really errored because their I/O connection was lost; the resumed
executions used the published version above. These are modeled provider effects.
A fresh consistent reader of DynamoDB Local also found all three rows confirmed
at epoch 2; that separate store read does not alter the public receipt's limits.

Keep the [business receipt](evidence/c9-calendar-slack/receipt-summary.json),
[Calendar crash witness](evidence/c9-calendar-slack/crash-observation-calendar.json),
[Slack crash witness](evidence/c9-calendar-slack/crash-observation-slack.json) and
[Deal control witness](evidence/c9-calendar-slack/crash-observation-deal.json)
separate. [Provider observations](evidence/c9-calendar-slack/provider-observations.json)
retain measured counts/IDs; [direct store read](evidence/c9-calendar-slack/direct-store-readback.json)
retains checkpoint identities. [Observation and limits](evidence/c9-calendar-slack/observation.json),
[source hashes](evidence/c9-calendar-slack/source-hashes.json),
[contract parity](evidence/c9-calendar-slack/contract-parity.json) and
[receipt screenshot](evidence/c9-calendar-slack/receipt.png) identify this attempt.
Original business check definitions and the prior bounded Deal oracle are unchanged.
The two new checks extend coverage; they are not a same-contract before/after
comparison with the older 17-check receipt.

The [pre-change process failures](evidence/c9-calendar-slack/before-process-tests.log),
[intermediate fixture failure](evidence/c9-calendar-slack/after-recovery-process.log),
[final 567-test run](evidence/c9-calendar-slack/full-suite-dynamo.log),
[seven harness checks](evidence/c9-calendar-slack/runtime-harness.log),
[contract gates](evidence/c9-calendar-slack/contract-gates.log) and
[rejected stale export](evidence/c9-calendar-slack/prior-export-rejected.log)
remain distinct. Calendar [listing failure/Slack history qualification](evidence/c9-calendar-slack/readback-qualification.json)
and [exact Calendar ID qualification](evidence/c9-calendar-slack/calendar-id-qualification.json)
are component observations, not substitute application proof.

Full C9 acceptance remains open for native negative controls, repeated full runs,
fresh builder acceptance and the other failure/interleaving boundaries. Temporary
transports and the disposable database are stopped after evidence capture; the
protected native workflow retains this published source, but its temporary I/O
transport must be re-established for another run.
