# C11: fresh sandbox-session state, retired keys and cleanup

The original state key used only the business lead ID. A local real-FileStore
reproduction showed that a second session using the same file inherited the
first session's claim. That failing test is retained separately from cloud
qualification. No customer records or live provider actions are involved.

## Application changes

`session-scope.mjs` derives a stable namespace from all four issued provider
sandbox identities. It verifies their exact first-party sandbox bindings. The
namespace stays stable on a restart with those same bindings and changes when a
fresh session gets different twins. `LeadState` requires a namespace, uses it for
claims/saves and returns an exact lead record rather than a prefix match. A save
from another namespace is refused. Unbound startup permits authenticated health
checks only; application operations return 503 until the real bindings exist.

The native n8n decision source is unchanged. This is scoped to the disposable
pilot adapter/FileStore, not a production state migration, multi-worker durable
store or a backend release. It does not implement C9 abandoned-claim recovery.

## Measured journey and separate audit

The existing MCP runner configures and drives the real published workflow. C11
uses the identical business lead `friendly-session-isolation` in each fresh
session. Each receipt must observe no starting app state, execute the normal
workflow and independently verify all five provider effects. Other 13 check
definitions are preserved. `PILOT_STATE_FILE` deliberately selects one physical
file for the two runs; old rows must remain unchanged while the new namespace
gets its own completed row. Starting with an empty file is insufficient proof.

`audit-c11.mjs` separately reviews the retained receipts and lifecycle observations.
`probe-session-lifecycle.py` performs read-only provider controls and denied old
verifier attempts after both runs, without running or judging a workflow. It
reconstructs the same completed-session adapter using the existing protected
native handoff through `node --env-file`, without opening or parsing handoff
contents in the agent/driver. Only statuses and local one-way comparison
fingerprints leave the native credential consumer; no secret values or provider
bodies are printed. It checks current access, retired verifier denial, old keys
against new twins, deleted old URLs and unchanged application state. Redirects
are refused and credential destinations must match actual first-party twins.

The replay handoffs are explicit private test fixtures, mode 0600 inside a mode
0700 directory. The existing runner removes its original native handoff. Both
replay copies, temporary bindings, active state file and owned transports must
be removed at the end; retained receipts are checked separately. Failed attempts
are preserved as failed/unmeasured evidence, not counted as successful sessions.

This is not native builder-agent acceptance. The shared long-lived pilot app
credential is not revoked between runs. Per-requester/tenant identity remains
C6; stale native callbacks/owners, abandoned claims, cross-worker recovery and
production session isolation remain unqualified. The artifact audit does not
turn those boundaries into passes.

## Execution status

The first cloud attempt did not reach C11: C5's request timed out and the next
reads returned `Local tunnel disconnected` / `Tunnel unavailable`. The native
execution subsequently finished and the UI showed no active executions. The
[interrupted receipt](https://fetchsandbox.com/runs/c8d78c6024?flow=vr_1e388808d7d64e2fb409066101453a1c)
records six passed and eight unmeasured. All four owned twins were deleted, the
receipt remained readable, and its replay handoff was removed. The underlying
cause of that relay disconnect is not confirmed. Subsequent runs capture private
MCP stderr diagnostics rather than discarding them.

## Qualified observations, retained separately

[Session A](https://fetchsandbox.com/runs/ee4b7a52e3?flow=vr_3c414b27034c47ec8cd6d4735b16f38d)
and [session B](https://fetchsandbox.com/runs/85dba866b9?flow=vr_8db50d4f9ef74348845204e0a919cbb3)
each record **11 passed, 0 failed, 3 unmeasured; overall inconclusive**.
Each has 55 passing independent provider-state assertions, including all five
C11 effects. Each native run began with no state for the identical business lead.
The checks hash is identical:
`62b8cbc028a68e0174690d19565477ac167e0bcde87f6b9bff917cf31afa41dc`.
The full shared file retained all old rows unchanged while the new scope got its
own completed record. This is a direct local file/configuration observation,
not independent remote database attestation. Do not add the two receipts' counts
or substitute their combined result for a new run.

The separate [lifecycle audit](evidence/2026-11-07-c11-lifecycle-audit.json) passed:
three retired-verifier requests returned 401; all four new twins accepted current
keys and denied retired keys. Slack returned HTTP 200 with a native authorization
error, which was counted as denial rather than HTTP success. Old sandbox URLs
returned 404. The probes did not change application state. Eight paired-session
twins were deleted, both receipts remained readable, original/replay handoffs and
temporary bindings were absent, the active shared state file was removed, and
ports 8097/4040 were closed. The first interrupted attempt's four twins and secrets
were separately cleaned up as well.

The first lifecycle positive control used Calendar's collection GET and returned
501 unsupported. That audit failed and is retained as a nonpassing observation.
The corrected control uses the supported GET of the exact event ID created by
session B and requires that ID to match. It returned 200; the retired key returned
401. No provider write was added to repair this audit setup.

Both actual native C11 executions (280 and 306) named version
`0397f00d-f536-4975-935b-fb705b780055` in their UI history link. The actual export
hash remains `28dd4054ebe1986ff2d4e232baa0d70898a6efa3f5f7d3740300514bd13712d4`.
Both runs used adapter bundle
`8e7c2dc11598eb251322939e8fd22b36ff4ee93a2449a5a349c2ee93e6ed95c1`.
The adapter changes were measured temporarily with the real cloud workflow and
then stopped; no backend release was deployed. C6, C9 and C12 remain unmeasured,
plus the broader negative-control, repeatability and native builder gates.

Local final gate: **508 tests passed across 70 files**, TypeScript passed, and the
Python/native credential-worker syntax checks passed. Earlier local failures
(single-role fixture, then undefined namespace coercion) were repaired before
these final results. The original old-implementation same-file claim failure
remains separate evidence.

For a repeat, use the ordinary `verify/relay-proof.mjs n8n-lead-recovery` lifecycle
with a fresh private `PROOF_OUT_DIR` for each run. Set `PILOT_STATE_FILE` to one
shared owned test file and `PILOT_REPLAY_HANDOFF` to a different private copy path
per run. The contract hook copies the opaque native handoff without reading it;
existing callers without these settings retain their default behavior. The copy
is exclusive and will not overwrite an existing file. Keep the first state read
and receipt before running the second session. The standalone credential probe
uses `session-a-out.json` and `session-b-out.json` path pointers, each run's actual
session metadata/handoff/bindings, and the retained `state-after-b-private.json`.
Run it after the second run but before deleting its twins/handoffs, then inspect
both receipts and run the artifact audit. Remove every test handoff and active
state file afterward. Never print or publish the handoff contents.

When extending provider bindings, update the namespace's exact expected role set
and its tests; do not introduce a shared default namespace. This sandbox-session
namespace is not a replacement for real requester identity or production leases.
