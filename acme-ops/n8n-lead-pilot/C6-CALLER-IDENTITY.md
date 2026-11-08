# C6: requester ownership and native invocation boundary

**Partial evidence, not a completed C6 milestone.** The application changes pass
local tests, and four native entry-rejection probes have observed HTTP outcomes.
Backend authentication-profile commit `f7eeee67` was deployed on November 8.
Public build/health, source hashes and capability discovery passed. The actual
`bc0acc3f` native export passed the source/wiring/credential guard. The full hosted
C6 receipt now records 15 held checks, including C6, and C9 unmeasured.
This is one hosted run, not completion of the broader acceptance gates. Do not count the previous C12 receipt as proof of this version.

## Inspected gaps and intended journey

The original bridge accepted one shared credential for requester and native I/O.
State had execution ownership but no authenticated requester owner. A conditional
save could substitute a requester value; a second authenticated caller was not
explicitly denied. Two local tests reproduced these ownership gaps before the fix.
The engine's frozen HTTP action contract could not omit/swap Authorization or
select a second authenticated test actor, so a real C6 denial suite could not run.

The app-owning agent proposes/freezes `contract.identity.json`; the existing
`validate_integration` package runner configures, starts and polls it. It invokes
the actual protected persistent n8n workflow through the same managed-relay path,
checks actual app state, independently reads provider effects and retains the
engine receipt. This remains scripted runtime qualification. Native builder-agent
contract preparation and independent review are separate acceptance gates.

## Application changes

- Caller identity comes from a private configured credential binding. Request
  fields cannot choose the authenticated subject or tenant. Missing/wrong or
  malformed Bearer credentials are denied.
- Each lead records its authenticated requester owner. Another requester cannot
  read or resume it. Conditional saves cannot replace that owner.
- The native Header Auth credential is an internal runtime credential; it cannot
  act as a caller at the bridge's public invocation route. The old bootstrap
  credential is retained only for the existing protected health/session purpose.
- For an accepted caller, the bridge mints a 90-second HMAC invocation bound to
  session, requester, lead and explicit retry flag. The native validator preserves
  the envelope. Every state/provider command verifies it. Missing, changed,
  expired or foreign-session tickets are refused before state/provider activity.
- Provider commands also require the current claimed execution owner and saved
  version. A ticket alone does not permit provider I/O before claim or from a
  stale checkpoint. The n8n decision machine still owns business transitions.

`FETCHSANDBOX_REQUESTER_A_TOKEN` and `FETCHSANDBOX_REQUESTER_B_TOKEN`, once issued
by the candidate engine's protected handoff, map to distinct disposable app
principals (`pilot-owner` and `pilot-other`). These are test identities, not real
FetchSandbox accounts or an OAuth integration. Existing caller/provider/token
handoff and trace mechanisms remain private. Do not print credentials or internal
invocations. Legacy rows with no requester are not silently assigned a new owner;
this pilot's new session namespace starts fresh and prior rows stay unchanged.

## Measurements retained separately

[Local evidence](evidence/2026-11-08-c6-local-gates.json): **528 tests / 73 files
passed**, and TypeScript passed. Actual local HTTP tests exercised missing/wrong
credentials, caller/runtime separation, malformed Bearer syntax, missing/forged
tickets, provider I/O before claim, stale checkpoint denial, cross-requester
read/resume denial and attempted owner substitution. State stayed unchanged in
the tested denied cases and no provider trace was created. These are local
component results, not cloud-provider evidence.

The first candidate publication still had the old HTTP status expression. A direct
cloud probe returned HTTP 200 with a `forbidden` body. That is a failed denial
status result, retained in [the failure observation](evidence/2026-11-08-c6-native-status-failure.json).
The saved expression was inspected, corrected, explicitly committed and republished.

[Native entry observation](evidence/2026-11-08-c6-native-entry.json), on published
version `bc0acc3f-d72b-4d5d-aadc-12df4001c4ee`:

| Probe | Observed status |
|---|---:|
| Native webhook without Header Auth | 403 |
| Native webhook with a wrong credential | 403 |
| Valid runtime credential but no signed invocation | 403, `caller_not_authorized` |
| Invalid business input | 400 |

Execution 370 independently displayed this native version in n8n. The HTTP status
measurements are separate from n8n's “Succeeded” execution label, which merely
means the workflow handled the rejection. These four entry probes do not establish
an authorized end-to-end run or independently unchanged provider effects.

## Backend candidate and frozen C6 contract

The candidate extends the existing application contract, private credential handoff,
HTTP driver and receipt writer. Actions select `configured`, `omitted`, `invalid`,
`requester_a` or `requester_b`; only declared server-issued profile credentials can
be selected. Contracts cannot inject arbitrary headers, keys or destinations.
Transport Host/managed-relay authentication and signed-event validation stay
server controlled. Issued opaque values are masked before receipt persistence.
The bounded contract cap grows from 64 to 128 KiB; other action/time/check limits
stay unchanged, so earlier assertions need not be removed to fit identity checks.

The draft `contract.identity.json` contains only the C6 overlay. The runner composes
it with the maintained base contract, preserving the other **15 check objects exactly**
without copying their oracles.
It first reads the already-created baseline lead as requester A, proves requester
B can authenticate at health but cannot read/resume A's lead, exercises missing
and invalid credentials on reads and writes, and replays as A. It requires the
same requester, execution owner, version and four resource identities afterward,
plus five independent provider counts. The complete candidate configuration is
71,268 bytes with its full version suffix. C9 remains a typed unmeasured check.

Select this candidate only after its backend is available, using the existing
runner's `PILOT_CONTRACT=identity`. The default contract retains its C6 blocker;
selecting a new contract is not evidence of execution. Do not substitute a special
app self-test endpoint or merge manual probes into an engine pass.

## Remaining acceptance steps

1. Unlock the Mac, preserve the stale first-candidate download separately and save
   a fresh native export of `bc0acc3f`. Verify its actual source/wiring/credential
   references before starting a runtime run.
2. Review/promote the tested backend candidate through the maintained canary and
   rollback path, preserving the current database, provider catalog, configuration
   and signing material. Recheck the predecessor revision immediately before cutover.
3. Bind the same attempt's requester credentials through the protected handoff.
   Run all 16 frozen checks via MCP. Expected scope is 15 held and C9 unmeasured,
   not whole-app verification. Measure actual results rather than assume them.
4. Inspect native executions, all five independently read provider effects, exact
   saved identities/version and denied-call outcomes. Retain failed/setup receipts;
   clean only owned twins and temporary bindings while preserving proof.

Real customer identity-provider integration, production credential revocation,
crash/distributed recovery, remaining negative controls, fresh builder acceptance
and three clean full-contract repetitions remain outside the measured result.

## November 8 deployment and first hosted attempt

Backend `f7eeee67` passed independent public build/health/capability checks and
PostgreSQL usage start/completion readback. Actual native export `bc0acc3f` passed
the six-node source, wiring and credential guard. The first hosted attempt
returned an [inconclusive receipt](https://fetchsandbox.com/runs/df36e2f364?flow=vr_b40b864aafab4539ba22f98f178a91d4):
all 16 checks are unmeasured because baseline returned HTTP 500. Native execution
372 identifies the I/O node's resource-not-found error. The required existing
n8n-to-adapter ngrok connection had been stopped after earlier cleanup. Restarting
that same origin/port repairs setup, not application behavior; a fresh run with
unchanged code and contract subsequently recorded 15 held checks and C9 unmeasured. The local adapter preflight did not
cover this reverse connection. Keep both attempts and never count setup repair
as a behavioral pass.

## Hosted C6 result after setup repair

[Measured receipt](https://fetchsandbox.com/runs/195b1f5273?flow=vr_65ed9d3fd6b844cca0dc7089200d6eaf),
backend `f7eeee67`, native `bc0acc3f`, npm MCP `0.7.30`: **15 held, C9 unmeasured**.
The runner correctly exits 1 because the whole-suite gate is not met;
`app_verified` and `complete` remain false. See the separate
[artifact audit](evidence/2026-11-08-c6-hosted-observation.json).

The C6 trace records 11 requests: requester B authenticates at `/ping` (200), but
cannot read or resume A's lead (403 each); missing/invalid credentials return 401
for reads and writes; A can read/replay (200). The entire saved record is identical
before/after, including requester, execution owner 373, version 13 and all four
business IDs. Five C6 provider assertions held. Across this single receipt,
all 70 independent provider-state assertions held. Native execution 373
independently displays the exact exported `bc0acc3f` version.

C9 remains unimplemented/unmeasured. A deliberately broken native C6 control,
three clean full-contract repetitions, independent fresh builder acceptance and
native SaaS qualification are still untested. This receipt does not merge or
replace the earlier inconclusive setup receipt.
