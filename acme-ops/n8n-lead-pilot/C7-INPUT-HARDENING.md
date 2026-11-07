# C7 input validation — native failure, local fix, deployment pending

This branch preserves a failed independent HTTP/component probe. It is not a
FetchSandbox business receipt and does not change the original C7 check to held.

## Observed failure on November 7, 2026

The existing published normal workflow version
`03207059-cc93-4ab8-834e-bcb70e46b2ce` accepted an authenticated request containing
an otherwise valid `lead_id` plus an unexpected field. Native execution 115
returned HTTP 200 / `confirmed`, created one state record, and produced modeled
Contact, Deal, Gmail, Calendar and Slack effects. The adapter rejected the same
input with HTTP 400 and no state. This exposed different validation at the two
public boundaries. All effects used four owned isolated twins; all four were
deleted with HTTP 200. No live SaaS delivery was tested.

The [sanitized component observation](evidence/2026-11-07-c7-component-failure.json)
retains this failure. Missing/wrong credentials separately returned adapter 401
and native 403. Those denials do not prove per-user authenticated identity (C6).

## Local source change — not deployed

`input.mjs` defines one self-contained strict parser, used by the adapter and
embedded into the first native Code node. It accepts a bounded lead ID and an
optional boolean `retry_failed`, rejecting arrays, null, invalid types and extra
fields before MIME construction, state claims or provider I/O. The native
machine returns a terminal rejection, and Respond to Webhook maps it to HTTP 400.
Valid input retains the normal claim/recovery path.

Local tests execute the generated Code-node source plus the decision function;
they are not executions inside n8n Cloud. The shared invalid-input corpus also
checks that the adapter makes no transport call. Existing business and mutation
tests remain enabled. The source guard must refuse the old native export after
this change; no generated file is relabeled as an actual native export.

## Local verification

- `npm test`: 464 tests passed across 66 files, including 28 new native-input
  and adapter/native corpus checks.
- `npm run check`: TypeScript passed.
- Old native export: expected setup rejection at `Validate dummy lead`; this is
  a guard check, not a runtime pass.
- Documentation checks: 53 business guides and 648 local link targets checked;
  external links and fragment anchors were not validated.

Private logs are retained under
`/Users/raj/promo/content/reddit/2026-11-06-pilot-scope/build/c7/`
as `native-fix-final-tests.log`, `native-fix-final-typecheck.log`, and
`stale-export-guard.log`.

## Remaining acceptance gates

1. Publish the three changed native-node parameters with existing saved auth,
   then capture the actual native export and publication version.
2. Repeat the malformed request directly against the native webhook: require
   HTTP 400, zero state records and zero independent provider effects.
3. Drive malformed input through the existing MCP lifecycle in a way that reaches
   the native boundary. Adapter-only rejection cannot satisfy native C7.
4. Rerun the unchanged executable business checks and inspect their independent
   state assertions; retain the separate before/after receipts and versions.
5. Keep C6 requester identity, native negative controls, crash/multiworker cases,
   repeated full-contract runs and native builder acceptance explicitly open.

No new backend engine deployment is included in this application fix. The latest
business receipt remains the separate C8 measurement linked in the README.
