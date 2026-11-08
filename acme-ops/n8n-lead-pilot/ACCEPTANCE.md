# Friendly pilot: acceptance and gap register

**Latest C12 measurement:** [before](https://fetchsandbox.com/runs/0abc26a3c8?flow=vr_cab3c45cbce34987b400f233ff8380bb)
recorded 12 passed and four unmeasured; [after](https://fetchsandbox.com/runs/bbde15a1ff?flow=vr_2300d889291e48b7914bf87b5ec98fba)
records **14 passed, 0 failed, 2 unmeasured**, with all **65 independent provider-state
assertions passing**. The same frozen contract measured HubSpot scope denial,
Slack early-retry hold and notification-only recovery. Archives show 42.044 seconds
between the rejected and accepted Slack posts and one write for each business
effect. Native version `17807f35` was published and independently observed in
executions 363/366. The temporary adapter was measured separately; no backend
release was deployed. **C6 identity and C9 crash recovery remain unmeasured; the
full receipt is inconclusive.** Live-provider quota/OAuth and broader quality gates
are not established. See [C12 proof and limits](C12-PERMISSIONS-BACKOFF.md).


**Earlier C11 qualification:** [session A](https://fetchsandbox.com/runs/ee4b7a52e3?flow=vr_3c414b27034c47ec8cd6d4735b16f38d)
and [session B](https://fetchsandbox.com/runs/85dba866b9?flow=vr_8db50d4f9ef74348845204e0a919cbb3)
each record **11 passed, 0 failed, 3 unmeasured**, with 55 passing independent
provider-state assertions per receipt. The same lead and physical file were reused:
old rows stayed unchanged, new scoped state was created, retired session keys were
denied, both receipts survived cleanup, and temporary secrets/transports were
removed. This is a bounded session-isolation result, not per-requester identity or
crash recovery. An earlier relay-disconnected attempt and unsupported Calendar
positive control are retained as nonpassing evidence. See [C11 proof and limits](C11-SESSION-ISOLATION.md).
At that C11 cutoff, C6, C9 and C12 were unmeasured. Native n8n stayed on `0397f00d`; the changed
temporary adapter was measured and stopped. No backend release was deployed.

**Latest C10 measurement:** [the denied-operation/privacy run](https://fetchsandbox.com/runs/deb9b73db1?flow=vr_5617af5dac3549c28afe4240d9317813)
records **10 passed, 0 failed, 4 unmeasured**, with all 50 independent provider-state
assertions passing. Seven denied operations returned 400, an unknown route returned
404, and C10 created no app/provider effects. A separate retained owner/anonymous
summary audit verified the tested dummy-secret masks and absence of seven supplied
credential values. The other nine executable checks passed again. C6, C9, C11 and
C12 remain unmeasured. See [C10 scope, before/after evidence and limits](C10-PRIVACY-BOUNDARIES.md).
The native workflow stayed on `0397f00d`; the changed temporary adapter was tested,
then stopped. No backend release was deployed.

Latest evening measurements: [C7 native rejection](C7-INPUT-HARDENING.md) and
[C4 native broken-control/restoration](C4-NATIVE-CONTROL.md) are recorded. The
restored normal run has nine held, five unmeasured and all 45 independent
provider-state assertions held. The deliberately wrong version failed C4;
C5 was unmeasured in that negative run because its fault was not observed.
Current normal native version: `0397f00d-f536-4975-935b-fb705b780055`. Actual restored
export capture subsequently passed the normal source guard; the behavioral run
still records its original declared export separately. Full quality gates remain open.

Measured cutoff: November 7, 2026. This is an execution plan, not a certification.
The [C3 observation](evidence/2026-11-07-c3-deployed-observation.json) records
C0/C1/C2 and both C3 phases on backend `a952b218` and MCP `0.7.30`: five checks
held, nine requirements unmeasured, overall inconclusive. Recovery is a separate
check of the same C3 business case. All 25 independent provider-state assertions
held. Results are scripted MCP/native-runtime proof only; full quality gates,
fresh builder acceptance and enterprise readiness remain open.

The [C4 observation](evidence/2026-11-07-c4-deployed-observation.json) adds a
separate measured receipt: six held, eight unmeasured, all 30 independent
provider-state assertions held. Native C4 blind-resend rejection remains
unmeasured pending actual native export access; normal source was republished
and separately remeasured with the same six checks and all 30 state assertions
held ([restored observation](evidence/2026-11-07-c4-restored-observation.json)).
See [C4 proof](C4-PROOF.md). These results do not close full quality gates.

The [C5 observation](evidence/2026-11-07-c5-deployed-observation.json) measures
the unavailable-lookup subtype: seven held, seven unmeasured, all 35 independent
provider-state assertions held on configuration release `8f2ee848`. Empty and
ambiguous read-back variants and a native C5 broken control remain unmeasured.
See [C5 proof](C5-PROOF.md).

The [C8 observation](evidence/2026-11-07-c8-concurrent-observation.json) records
four overlapping first deliveries and completed replay through one adapter
process: eight checks held, six unmeasured, all 40 independent provider-state
assertions held. Native stale-writer/claim-bypass and distributed/crash scope
remain open; see [C8 proof](C8-PROOF.md).

## Roles and evidence boundary

The workflow builder owns n8n logic, state, input validation and recovery.
FetchSandbox owns scenario dispatch, execution orchestration, independent effect
observations and honest verdicts. The same engineer may implement both, but this
does not establish independent review. A fresh builder acceptance run and separate
review of the frozen oracle are still required.

The adapter currently hosts the application's conditional FileStore and bounded
provider transport; it is part of the application under test. `/proof` exposes
application claims. Those claims cannot establish external effects: FetchSandbox
must read provider collections independently. A generated export comparison is
a setup guard, not runtime proof or a digital attestation of n8n's execution.

Never add scenario-specific answers, fabricated effects, verifier-only recovery,
or branches keyed on a check ID to application code. Run IDs may isolate fixtures
and correlate evidence; they must not change business decisions. Do not weaken
count, identity, association or fault-witness assertions to obtain a pass.

## Remaining checks and actual work

| Check | Required behavior | Current gap and owner | Next acceptance evidence |
|---|---|---|---|
| C2 | Deal accepted, response lost | Normal native recovery and deliberately broken blind-retry versions are measured separately. The broken version failed C2 with two committed Deal IDs. Normal source restored and remeasured: C2 held under the same checks. Broader full-contract quality gates remain open. | Actual client timeout after one committed Deal; positive exact Deal/Contact read-back; no second Deal. Blind-retry variant must fail. |
| C3 | Gmail rejected after CRM | Measured: exact direct-send once-only 403 and independent zero-message/Calendar state; explicit recovery retained CRM IDs and created one email/event. Native broken control and full repeatability remain open. | Exact direct-send rejection witnessed, CRM identities retained, no email/Calendar effects; explicit safe retry retains CRM identities. |
| C4 | Gmail accepted, response lost | Measured normal native n8n: one accepted message, client disconnect, exact SENT/recipient/Message-ID read-back, one later Calendar event, no second send. Native blind-resend control now caught C4 with two distinct modeled messages; corrected source restored and remeasured. Actual restored export subsequently captured and passed the normal source guard. | One committed message, actual app timeout, positive Message-ID/recipient/SENT read-back, one Calendar event; blind-resend variant fails. |
| C5 | Gmail outcome remains unknown | Unavailable-lookup subtype measured through native n8n: one accepted email, two lookup 503s, three unknown outcomes including retry_failed, no resend or Calendar. Empty/ambiguous read-back and native broken control remain unmeasured. | Fault witness plus independent absence of Calendar effects, correct saved unknown state and Slack outcome. |
| C6 | Caller identity boundaries | Builder: shared pilot bearer is not per-requester identity. Qualification: missing/wrong native headers returned 403 outside this contract only. | Denied calls leave state/effects unchanged; intended requester isolation and authenticated identity explicitly specified and tested. |
| C7 | Invalid input/schema | Native defect reproduced; shared validator deployed as `2b310b22`. MCP measured five malformed forms at adapter and native entry (ten HTTP 400s), zero C7 provider I/O, five independent zero-effect assertions. Broader fuzzing remains outside measured scope. | See [C7 proof](C7-INPUT-HARDENING.md); native identity and full quality gates remain separate. |
| C8 | Concurrent first deliveries | Four overlapping native deliveries measured: one owner, one set of effects and no effects on completed replay. Single adapter/FileStore only; stale-writer native exercise, claim-bypass mutation, crash and multi-worker scope unmeasured. | Overlapping real n8n executions, exact one-effect counts and identities, stale writer rejected; claim-bypass variant fails. |
| C9 | Restart/abandoned claim | Builder implementation gap: no safe lease/fencing/reconciliation for abandoned `in_progress`; single-process FileStore. | Crash at each write/checkpoint boundary; restart with durable conditional store; no duplicated or lost effects, stale owner fenced. |
| C10 | Privacy/transport | Measured: seven forbidden operations returned 400, unknown route 404, zero C10 effects; separate saved owner/anonymous artifact audit passed for tested dummy secrets and supplied credentials. Full proof requires authentication. | Exact measured methods/paths, independent zero-effect checks, retained-artifact canary masks; no claim of arbitrary PII removal, exhaustive SSRF coverage or native 3xx fault injection. |
| C11 | Cleanup/isolation/receipt | Measured two real sessions with same lead/file: old rows retained, new namespaced state; retired verifier/provider credentials denied; receipts retained after cleanup and temporary state/handoffs/transports removed. | See C11 proof. Shared app credential/requester identity, stale callback/owner fencing and cross-worker crash recovery remain outside this result. |
| C12 | Scope/rate-limit failures | HubSpot scope denial, Slack 30-second hold and explicit notification-only recovery measured in one frozen native run. Other providers, OAuth/quota fidelity and native broken controls remain unqualified. | See [C12 proof](C12-PERMISSIONS-BACKOFF.md): three checks held, real timing audit, retained business identities and independent bounded effects. |

These are not eleven confirmed core-engine defects. They include provider
scenario gaps, application gaps and missing runtime qualification. Classify a
core defect only after reproducing it in the existing engine path.

## HubSpot deployment and separate Gmail candidate

Candidate branch `fix/n8n-exact-provider-faults` extends the existing HubSpot/Gmail
scenario YAML and shared HTTP/archive/evidence paths. The final local gate is
77 passed and one not-applicable parameter skipped. Real socket tests establish
write-before-client-timeout and exact read-back; deliberately repeating the write
creates a second effect which the existing evidence judge rejects. New controls
are `deal_accepted_response_loss`, `direct_send_rejected` and
`direct_send_accepted_response_loss`. The 10-second response hold exceeds the
pilot adapter's six-second timeout. The HubSpot control is deployed and C2 has native positive receipts. Backend
`a952b218` now enables Gmail scenario configuration, including the locally and
publicly qualified `direct_send_rejected_once`. C3 rejection/recovery has a native
workflow receipt; C4 normal recovery and C5 unavailable-lookup hold now have separate native runtime receipts; other C5 variants remain unmeasured. Zero-step alias rejection remains in
the unchanged runtime image. See [C3 proof](C3-PROOF.md) for its separate
80-passed/one-skipped backend gate and 434 workflow tests. The full three integrity failures observed
in the expanded gate reproduced on unchanged HEAD provider configs; no baselines
were changed. See the backend branch's
`docs/reviews/n8n-exact-provider-faults-20261107/observation.json` for exact scope.

## Milestones, in order

1. **Qualify exact provider faults.** Extend the existing YAML/scenario/router
   path. First reproduce missing direct-send/Deal controls. Test real HTTP
   mutation-before-timeout, disconnect witnesses, read-back identity and a
   deliberately duplicated write. Do not substitute 503 for accepted-but-lost.
2. **Execute C2–C5 and C12 through the existing MCP suite.** Freeze explicit
   requirements before running. Keep failed/control receipts separate. Fix the
   engine if fault dispatch/evidence is wrong; fix the workflow if recovery is
   wrong. Preserve the original failing receipt and identify contract changes.
3. **Execute C6–C8 and C10–C11.** Use real published entry points and independent
   no-write/count/identity checks. Authentication setup success alone is not C6.
4. **Implement and qualify C9.** Use the existing conditional-store abstraction
   and fencing/reconciliation rather than removing abandoned claims blindly.
5. **Negative controls and repeatability.** Deploy separately identified broken
   variants and the corrected workflow against the same frozen business checks.
   Export guards reject unregistered decision code. Explicit registered variant
   support is now locally tested; successful source registration is not proof
   that the engine catches the behavioral mutation. The native C2 blind-retry control now has a failing receipt; other behavioral
   mutations remain unmeasured.
   Each broken behavior must fail its intended oracle, followed by three fresh
   clean repetitions of the corrected application. Report every attempt.
6. **Native builder acceptance.** A fresh builder agent receives the ordinary
   customer goal, inspects the app and uses published FetchSandbox MCP without
   seeded answers or a hand-written scenario controller. It must discover the
   applicable risks, bind protected twins, run/poll and explain the retained
   receipt. Scripted orchestration cannot satisfy this milestone.

Completion requires every agreed check to pass, intended negative controls to
fail, reproducibility evidence, and native builder acceptance. Native SaaS parity,
tenant isolation, availability/SLOs, operational ownership and production data
controls need their own explicit qualification; this isolated pilot does not
establish them.
