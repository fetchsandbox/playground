# C6: requester ownership and native invocation boundary

**Partial evidence, not a completed C6 milestone.** The application changes pass
local tests, and four native entry-rejection probes have observed HTTP outcomes.
The backend authentication-profile extension is a local candidate. The actual
current native export, source guard, backend rollout and full hosted C6 receipt
are still pending. Do not count the previous C12 receipt as proof of this version.

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
