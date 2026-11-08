# C12: bounded provider permission and notification backoff qualification

This change targets the Friendly pilot application, not a new verifier or a
backend release. The n8n workflow continues to own decisions; the application
adapter provides conditional state and an allowlisted twin transport. Existing
`validate_integration` orchestration supplies faults, drives the real persistent
native webhook, and reads provider state independently.

## Defect and fix

The transport discarded `Retry-After`. Native logic saved a rejected Slack
notification as `unknown`; a completed lead could not resume that notification.
Three local tests failed on the original implementation. The corrected transport
retains only normalized retry timing from HTTP 429 (bounded delta seconds or an
HTTP date), never arbitrary provider headers. Missing/malformed timing remains
unknown. Native logic persists `rate_limited` separately from confirmed business
operations. The conditional claim permits one explicit retry only after the saved
real-clock deadline, skips confirmed business operations, and retries the
notification. Completed unknown notifications are not eligible for blind resend.

## Frozen contract

All 13 earlier check objects remain byte-for-byte equivalent after JSON parsing;
only repeated review prose was shortened to fit the existing 65,536-byte engine
configuration limit. A regression gate freezes their hash and checks the actual
configuration encoding including export and adapter version suffixes. C6 and C9
remain explicit blockers. C12 is split into three linked cases in one receipt:

| Check | Trigger | Required observed behavior |
|---|---|---|
| C12 | HubSpot `scope_denied` | Real twin request rejects with 403; app does not confirm Contact; independent Contact, Deal, Gmail and Calendar counts stay zero. |
| C12_hold | Slack `rate_limited`, `Retry-After: 30` | Complete business effects once; persist pending notification/deadline; immediate explicit replay does not send another Slack request; independent Slack count stays zero. |
| C12_recover | Same lead, default provider restored | Seven actual five-second waits; retain saved business identities; two concurrent explicit retries and a completed replay produce one accepted notification and no extra business writes. Independent counts are one across all five effects. |

The hold case checks Slack absence independently. The linked recovery case checks
all business counts and saved identities within the same frozen run. A separate
read-only audit of that receipt's archives checks the actual interval between
Slack posts, the early replay's completion before the deadline, each business
write count, and returned business identities. It supplements the receipt; it is
not another verifier or a replacement for independent provider observations.

## Evidence and limits

Runtime results, exact versions, before/after URLs and cleanup are recorded below
only after collection. Setup failure is not a failed application check. A missing
required observation remains unmeasured, never a pass.

This qualifies controlled HubSpot scope-denial and Slack rate-limit shapes in
isolated FetchSandbox twins. It does not establish live HubSpot OAuth scopes,
Slack quota behavior, other providers' rate limits, every endpoint's permissions,
crash-safe retry scheduling, distributed workers or authenticated requester
identity. Slack's separate `missing_scope` fixture describes a different endpoint
and is not claimed as a qualified `chat.postMessage` fault. No email, Calendar
invitation or Slack message is delivered to a real customer.

## Before measurement — retained separately

[Before receipt](https://fetchsandbox.com/runs/0abc26a3c8?flow=vr_cab3c45cbce34987b400f233ff8380bb):
12 held, 0 violated, 4 unmeasured; all 60 measured independent provider-state
assertions held. C12's HubSpot 403 was witnessed. Slack's 429 and `Retry-After: 30`
were witnessed, but required saved retry timing was missing, so `C12_hold` was
unmeasured and `C12_recover` did not run because its starting-state precondition
was absent. C6/C9 were also unmeasured. This is not a positive rate-limit result.
Native version `0397f00d-f536-4975-935b-fb705b780055`; export SHA
`28dd4054ebe1986ff2d4e232baa0d70898a6efa3f5f7d3740300514bd13712d4`;
adapter SHA `8e7c2dc11598eb251322939e8fd22b36ff4ee93a2449a5a349c2ee93e6ed95c1`.
[Sanitized observation](evidence/2026-11-08-c12-before.json) preserves the receipt.

The corrected native version is `17807f35-9106-41f2-84a7-f6586680261d`,
“Persist Retry-After for notification-only recovery.” The actual browser export
has `active: true`, SHA
`93f733eceab8658b39c1994c327208f49e871e7fab5266d0af2604cd61aafc71`, and passed
normal source/wiring/credential-reference checks. Native execution 363 separately
displayed this version in its history link; this establishes the observed
execution's version, not universal attestation of every execution.
Corrected adapter SHA:
`994cff511a307ecd8c1fd8205518902cf75d389ff9447372d4c2b839973cebfd`.

The first after-run launch failed locally because an absolute bundle path was
joined twice. No session or application run was created. That setup failure was
retained, the invocation path was corrected, and the fresh runtime run is separate.

## After measurement and remaining gaps

[After receipt](https://fetchsandbox.com/runs/bbde15a1ff?flow=vr_2300d889291e48b7914bf87b5ec98fba):
**14 held, 0 violated, 2 unmeasured**, all **65 independent provider-state
assertions held**. All three C12 cases held. C6 requester identity and C9 live
crash/abandoned-claim recovery remain unmeasured; the overall verdict is
**inconclusive**, and the runner exits 1 honestly. The earlier 13 check definitions
were unchanged; all previously executable checks passed in this observed run.
This does not establish unmeasured behavior or the full regression quality gate.

The [artifact audit](evidence/2026-11-08-c12-artifact-audit.json) confirms exactly two
Slack attempts for this rate-limited lead: one 429 and one accepted request,
**42.044 seconds apart**. The early explicit retry finished before the saved
30-second deadline and did not send a second request. After the actual wait,
two concurrent explicit retries and a completed replay produced one notification.
Each Contact, Deal, Gmail and Calendar write occurred once and its returned ID
matched both the pre-retry and final saved ID. This audit inspected this one
receipt's archived requests and the adapter trace, rather than merging results
from different runs. Native recovery execution 366 also displayed version
`17807f35` independently in the n8n UI.

[Sanitized after observation](evidence/2026-11-08-c12-after.json) records hashes,
MCP `0.7.30`, native version and scope. Actual application configuration encoding
was 65,396 bytes. Local regression gate: **520 tests / 71 files passed** and
`tsc --noEmit` passed; the final size/frozen-oracle gate also passed after matching
the real bridge-version suffix. These local tests are separate from cloud proof.

The workflow version is published; its adapter was a temporary single-process
proof runtime, not a durable hosted production service. No FetchSandbox backend
release was needed or deployed. Live-provider scope/quota qualification, C6/C9,
remaining native negative controls, fresh builder acceptance and three clean
full-contract repetitions remain open.

Cleanup: each of the four owned twins in each run returned HTTP 200 on deletion;
each retained owner receipt still returned 200 afterward. Temporary app bindings
and FileStore state were removed, the owned transport stopped, and ports 8097 and
4040 were closed. Before cleanup, anonymous summary access returned 200 while
full unauthenticated proof access returned 401. Historical snapshots/archives and
exact private logs remain in Raj's C12 evidence directory; no credentials or raw
private exports are committed.
