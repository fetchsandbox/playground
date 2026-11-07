# Friendly pilot: acceptance and gap register

Measured cutoff: November 7, 2026. This is an execution plan, not a certification.
The [current observation](evidence/2026-11-07-repeatable-c0-c1-observation.json)
records historical C0/C1 proof. The [new C2 observation](evidence/2026-11-07-c2-deployed-observation.json)
records C0/C1/C2 on deployed backend `33290a2d` and MCP `0.7.30`. Ten requirements
remain unmeasured. All results are scripted MCP/runtime proof only. No enterprise-readiness
claim is supported yet.

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
| C2 | Deal accepted, response lost | Exact Deal-create control is deployed; normal native workflow passed C2 twice. Native broken-workflow control still needs Mac export access. | Actual client timeout after one committed Deal; positive exact Deal/Contact read-back; no second Deal. Blind-retry variant must fail. |
| C3 | Gmail rejected after CRM | FetchSandbox qualification: existing `send_unavailable` targets **draft send**, but this workflow calls **direct message send**. These are not interchangeable. | Exact direct-send rejection witnessed, CRM identities retained, no email/Calendar effects; explicit safe retry retains CRM identities. |
| C4 | Gmail accepted, response lost | FetchSandbox qualification: direct-send post-commit response-loss scenario and client-disconnect witness unqualified. | One committed message, actual app timeout, positive Message-ID/recipient/SENT read-back, one Calendar event; blind-resend variant fails. |
| C5 | Gmail outcome remains unknown | Both: qualify unavailable/ambiguous read-back and prove the application withholds Calendar and reports unknown. | Fault witness plus independent absence of Calendar effects, correct saved unknown state and Slack outcome. |
| C6 | Caller identity boundaries | Builder: shared pilot bearer is not per-requester identity. Qualification: missing/wrong native headers returned 403 outside this contract only. | Denied calls leave state/effects unchanged; intended requester isolation and authenticated identity explicitly specified and tested. |
| C7 | Invalid input/schema | Qualification: local validation tests only. | Actual published-entry invalid requests with unchanged independent effects and retained rejected-call evidence. |
| C8 | Concurrent first deliveries | Qualification: local conditional-claim/CAS tests only. | Overlapping real n8n executions, exact one-effect counts and identities, stale writer rejected; claim-bypass variant fails. |
| C9 | Restart/abandoned claim | Builder implementation gap: no safe lease/fencing/reconciliation for abandoned `in_progress`; single-process FileStore. | Crash at each write/checkpoint boundary; restart with durable conditional store; no duplicated or lost effects, stale owner fenced. |
| C10 | Privacy/transport | Qualification: allowlist implementation exists, deployed denied-route/redaction checks absent. | Blocked arbitrary destination, redirect and secret-bearing attempts; independently inspected receipt/export for credential leaks. |
| C11 | Cleanup/isolation/receipt | Qualification: four owned sandboxes absent on recheck, receipt retained; full fresh-session isolation contract not executed. | New session cannot read/reuse prior state/credentials; receipt retained after cleanup; temporary transports and handoff files removed. |
| C12 | Scope/rate-limit failures | FetchSandbox qualification: existing faults need exact-operation qualification, not inferred support. | Native-shaped rejection/429, observed Retry-After handling, no false confirmation/unsafe resend, independently unchanged or bounded effects. |

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
pilot adapter's six-second timeout. The HubSpot control is deployed and C2 has native positive receipts; C3–C5 do
not become passes from local tests. Current backend `33290a2d` also rejects
invalid zero-step aliases before execution. Gmail controls are not enabled in
the active mounted configuration. The full three integrity failures observed
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
   that the engine catches the behavioral mutation. Native execution remains
   pending Mac export access.
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
