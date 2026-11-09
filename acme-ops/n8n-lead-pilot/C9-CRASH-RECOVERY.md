# C9: abandoned claims and process crashes

**Candidate implementation and local process evidence only. Not deployed.**
The published native version remains the previously measured `bc0acc3f`; backend
`f7eeee67` and its 15-passed/C9-unmeasured receipt are historical, unchanged evidence.
C9 is still typed unmeasured in the unchanged, frozen FetchSandbox contract. Its historical blocker wording remains byte-for-byte preserved; this candidate document records the newer local implementation status. No new engine receipt
or native builder acceptance is claimed here.

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
accepted-write/before-checkpoint failure. The existing lifecycle supports restart;
the C9-specific native failure boundary and executable contract are not yet qualified.

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

No customer contact, backend deployment or native workflow publication was performed
for this local candidate. The native C9 milestone remains open.

A documentation edit to the frozen C9 blocker changed its hash and configuration byte count; two contract-identity gates rejected it. The entire contract was restored unchanged rather than repinning those gates. The failed metadata check is retained separately.
