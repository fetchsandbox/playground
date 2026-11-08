# C7 native input rejection — deployed and measured, broader pilot open

The [MCP receipt](https://fetchsandbox.com/runs/65f5fcf6f9?flow=vr_d8a77b680e2c4d4b80da36395e709f87)
records **nine checks held, five unmeasured; overall inconclusive**. All 45
independent provider-state assertions held. This does not close the full pilot.

## Original failure, retained separately

The published normal workflow version `03207059-cc93-4ab8-834e-bcb70e46b2ce`
accepted an authenticated request containing a valid `lead_id` plus an unexpected
field. Native execution 115 returned HTTP 200 / `confirmed`, created one state
record, and produced modeled Contact, Deal, Gmail, Calendar and Slack effects.
The adapter rejected that same malformed business payload with HTTP 400 and no
state. This was an application boundary defect, not an identified core-engine
fault. The [before observation](evidence/2026-11-07-c7-component-failure.json)
is an independent HTTP/component result, not a FetchSandbox business receipt.

All effects used owned isolated twins. No live email, calendar invitations or
Slack delivery was exercised. The four probe twins were deleted with HTTP 200.

## Fix and actual deployed source

Commit `e2bd930` adds one self-contained parser in `input.mjs`, used by the
adapter and embedded into the first native Code node. It accepts a bounded lead
ID and optional boolean `retry_failed`, rejecting extra fields and wrong types
before MIME construction, state claims or provider I/O. The machine terminates
with `rejected`; the response node maps that result to HTTP 400. Valid input
keeps the existing claim/recovery path.

Native version `2b310b22-53cc-4beb-a936-095a41c6b121` was actually published and
exported through n8n on November 7. Export SHA256:
`9364f3dbdd9be37bbd188ada820c1869cd88d304768a43c4f3440785bef6060a`.
The source guard accepted that actual export. Execution 116 independently named
that version in the UI; the private DOM and screenshot are retained.

The direct same-payload recheck returned HTTP 400 / `rejected`, zero app records
and zero provider writes. Its [after observation](evidence/2026-11-07-c7-native-component-after.json)
is separate from the MCP receipt. An earlier after-attempt stopped at a bundle
startup error (`Dynamic require of node:https`), before invoking n8n. That setup
failure is retained; rebuilding with the existing `build-adapter.mjs` resolved it.
It is not counted as a runtime pass.

## MCP must reach the native boundary

An adapter-only rejection would conceal the original native defect. Commit
`e9413e2` therefore adds authenticated `POST /native-invoke`: a raw-body transport
to the same fixed, credential-bound native webhook, with no local business
validation. It accepts no caller-supplied destination, follows no redirects,
performs no automatic retry, and uses the existing bounded request size/timeout.
`POST /invoke` retains adapter validation. This is transport to the actual
application, not another verifier or a scenario-specific controller.

C7 is now executable in the original contract. It sends the same five invalid
forms to both surfaces: an unexpected field, string/number/array `retry_failed`,
and a forged rejection marker. All ten actions returned 400; all five native
responses named `rejected`. Before/after lead state was empty. The engine recorded
zero provider requests for C7; all five independent collection assertions held.

All 13 other check definitions were unchanged. The eight previously executable
business checks held again. The prior MCP contract had C7 unmeasured, so this is
an expanded contract with retained component before/after evidence, not an
identical frozen MCP contract before/after the original bug.

[Sanitized MCP observation](evidence/2026-11-07-c7-mcp-observation.json).
The four run twins were deleted with HTTP 200; the owner snapshot remained
readable with HTTP 200 and the temporary bindings file was removed.

## Local verification and remaining scope

`npm test`: **467 tests passed across 66 files**. `npm run check`: TypeScript
passed. Tests execute generated native source, compare adapter/native invalid
input, and qualify fixed transport/no-redirect/no-retry behavior. They do not
replace native execution. The old actual export was correctly rejected after the
source change; that is a setup guard, not runtime proof.

Private source/export/probe/log evidence is under
`/Users/raj/promo/content/reddit/2026-11-06-pilot-scope/build/c7/`.
Backend image is `fetchsandbox-backend:8f2ee848`, with observed
`FS_GIT_COMMIT=8f2ee848` and `DEPLOYMENT_VERSION=fdd1d243`; this C7 work did not
deploy a new backend or attest every existing runtime overlay hash.

C6, C9, C10, C11 and C12 remain unmeasured. Broader native negative controls,
three full-contract repetitions, fresh builder acceptance, native SaaS parity and
production operation remain separate open gates. The measured C7 scope is five
malformed forms, not exhaustive schema fuzzing or requester identity isolation.


## Later native restoration observation

The subsequent [native C4 negative control and normal restoration](C4-NATIVE-CONTROL.md)
kept this parser and response code unchanged. The current normal publication is
`0397f00d-f536-4975-935b-fb705b780055`. A fresh restored receipt again measured all
ten C7 rejections; all nine executable checks and 45 provider-state assertions
held. The actual restored export was subsequently saved and passed the normal source
guard (SHA256 `28dd4054ebe1986ff2d4e232baa0d70898a6efa3f5f7d3740300514bd13712d4`). The behavioral run used the earlier actual normal
export without rewriting metadata; this later source check is separate.
