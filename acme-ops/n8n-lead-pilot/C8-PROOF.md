# C8: four overlapping first deliveries, one set of effects

The [November 7 C8 receipt](https://fetchsandbox.com/runs/7f05cd5343?flow=vr_68013d37ab44438e8aca5f6a652f908e)
held C0/C1/C2, both C3 phases, C4, C5's unavailable-lookup case and this bounded
C8 case: **eight checks held, six unmeasured; overall inconclusive**. All 40
independent provider-state assertions held. C0–C5 business checks were unchanged
from the preceding C5 run; results from separate receipts are not combined.
See [the sanitized observation](evidence/2026-11-07-c8-concurrent-observation.json).

This measures four real overlapping HTTP deliveries through the published native
n8n webhook, using **one adapter/FileStore process** and isolated provider twins.
It does not establish distributed ownership, crash recovery, abandoned-claim
reconciliation, native SaaS delivery or fresh builder-agent acceptance.

## Observed sequence

1. The standard MCP executor started four POST `/invoke` calls for the same fresh
   lead concurrently. All four returned HTTP 200. Their recorded request windows
   overlap together for 2.008216 seconds; this was not sequential redelivery.
2. Native history showed executions 110–113 starting while the owner was active.
   Execution 110 owned the lead and took 11.473 seconds in n8n. The other three
   native executions finished without business writes. Their app responses were
   `in_progress`, not invented successful completions.
3. The existing executor awaited every concurrent request before observing state.
   One result was confirmed; three reported the existing in-progress owner 110.
   The application subsequently reported one confirmed record and owner 110.
4. Independent provider-state assertions established exactly one Contact, one
   correctly associated Deal, one Gmail message, one Calendar event and one Slack
   notification for the lead. Archived provider requests used default scenarios.
5. A completed replay (native execution 114) retained owner 110 and every saved
   resource ID. It made **no provider requests**. Exact final IDs were bound to
   the app checkpoint read after the overlapping batch, then independently
   compared with provider collections.

The existing `LeadState` conditional-create path admitted one owner. No decision
logic, state-store implementation, native source or adapter bundle was changed.
The contract uses the existing generic HTTP `concurrency:4` action. Every response
status is checked and every sibling request is drained before a result; a single
convenient response is not selected as proof of four successful business runs.

## Version and scope

Backend configuration build `8f2ee848` and published MCP `0.7.30` were used.
Native execution 110 independently named unchanged normal version
`03207059-cc93-4ab8-834e-bcb70e46b2ce`. The prior actual normal export was reused;
its historical metadata was not rewritten. Current native version was observed
separately. The receipt's source version is declared, not a cryptographic runtime
attestation. No native edit, new export, laptop unlock or new credential was needed.

The existing workflow gate passed 436 tests across 65 files; TypeScript passed.
C8 required no backend release beyond the already-qualified C5 configuration
release. Backend and component checks for that release are recorded separately
in [C5 proof](C5-PROOF.md). Native execution success badges are not business proof;
three of the four initial requests explicitly returned in progress.

The run's four owned twin sandboxes were deleted with HTTP 200. The snapshot
remained readable, temporary bindings were removed, and the local adapter and
owned ngrok process were stopped. Release candidate and its private SSH forward
had already been stopped. These observations do not satisfy the full C11
fresh-session isolation contract.

## Remaining C8 and pilot quality gates

The native stale-writer exercise and deliberately broken claim-bypass control
remain unmeasured. Existing local CAS/stale-save tests are separate evidence.
A single-process conditional JSON store does not establish multiple-worker
coordination or crash safety. Full C8 acceptance remains open for those gates.
C4's native bad-control export, other C5 lookup variants, C6/C7/C9–C12,
three clean full-contract repetitions and fresh native builder acceptance also
remain open. Source-capture automation remains deferred by the owner.
