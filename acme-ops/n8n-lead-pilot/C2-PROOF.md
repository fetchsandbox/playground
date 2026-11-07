# C2: recover a HubSpot Deal after its accepted response is lost

The normal published n8n workflow has passed C2, together with unchanged C0 and
C1 checks, in this [measured receipt](https://fetchsandbox.com/runs/2bf995e8ee?flow=vr_7b4d8b1954a24a49a1246317b363a6ca).
It is **inconclusive overall: three held, ten unmeasured**. This run used backend
`33290a2d`, published MCP `0.7.30`, native workflow `PJlTC5gnf6wb0r8e`, observed
native version `abd2c751-c25e-459f-99c4-4616910156e6`, and the export/bridge hashes
recorded in the receipt. Native execution history independently showed C2's
first and recovery executions as 27 and 28 under that version.

The native deliberately broken control has now run in a separate
[failed receipt](https://fetchsandbox.com/runs/57600c06f2?flow=vr_089aa5dd07534b45a9686a2c44403bb9).
C2 violated with “Accepted response read-back repeated the provider write.” The
archive records two distinct committed Deals for the same lead even though the
application reported confirmed. The original business assertions were unchanged.
See [the negative-control observation](evidence/2026-11-07-c2-native-negative-observation.json).
Normal source was restored and published; its post-restoration measurement is
recorded separately below. Full-contract repetition, other cases'
negative controls and fresh builder acceptance remain open.

## What actually happened

1. FetchSandbox used the managed relay and protected adapter to invoke the
   published native n8n webhook. The app created its Contact and submitted a Deal
   naming that Contact's ID. All providers were isolated twins.
2. The existing HubSpot twin committed the Deal normally with status 201. Its
   `deal_accepted_response_loss` scenario delayed the first successful reply for
   10 seconds. It did not substitute an error before the write.
3. The actual adapter client disconnected about six seconds after acceptance:
   the archive records delay start `15:54:44.110567Z` and client disconnect
   `15:54:50.056748Z` on November 7, 2026. n8n saved `unknown` at the Deal step,
   with Gmail and Calendar still pending, and notified Slack of that outcome.
4. FetchSandbox invoked the same business lead again. n8n searched for the Deal,
   read its exact returned ID, checked its Contact association, and resumed.
   It did not POST another Deal.
5. Independent provider-state assertions established one Contact, one correctly
   associated Deal, one Gmail message and one Calendar event for that lead.
   Slack held one unknown-at-Deal notification and one final confirmed outcome.
   The Contact ID matched the first response; final IDs matched the recovered
   second response. All 15 independent state assertions across C0/C1/C2 held.

These are modeled provider effects, not native mail delivery or Calendar
invitations. Native HubSpot/Gmail outage parity, requester isolation, crash
recovery and unprimed builder acceptance are separate requirements.

An [earlier corrected-contract positive run](https://fetchsandbox.com/runs/801552478c?flow=vr_d1010ffe378c472aa1529deb0d82d574)
also held C0/C1/C2 on backend `7edde7e4`. The final run repeated the same corrected
contract after deploying the validator improvement. The totals are separate;
they are not merged. See [the sanitized final observation](evidence/2026-11-07-c2-deployed-observation.json).

## Contract error retained, not relabeled

The [first C2 receipt](https://fetchsandbox.com/runs/a1a8166098?flow=vr_fabe92fef74c463f99dec61603283e78)
is failed: C0/C1 held, C2 violated, ten checks unmeasured. The contract author
incorrectly used `step0` for the first response and copied final-ID bindings from
the first unknown response. This was not evidence of an application duplicate.
The corrected contract uses `step1` for the first Contact and `step2` for final
IDs, preserving every count/identity/relationship requirement. The successful
run is a fresh measurement with the corrected contract, not a same-contract
application fix or an edited historical receipt.

FetchSandbox backend `33290a2d` now rejects zero-step aliases during configuration
with HTTP 400 and guidance to `step1` or `steps.0`, before application execution.
Four malformed-reference tests failed before this fix; six targeted tests then
passed, including actual executions with the two supported aliases. The expanded
backend rerun passed 343 tests with one not-applicable parameter skipped. An
earlier missing-MCP-build setup failure is retained separately.

## Repeating this bounded pilot

Use the setup and protected credential handoff in [README](README.md). Start the
existing n8n-to-adapter HTTPS transport before the standard runner. The measured
path is MCP → managed relay → local adapter → published n8n webhook; n8n Cloud's
I/O back to the adapter uses separate ngrok HTTPS. Do not call that second path
managed-tunnel support or replace it silently with a different runtime.

The contract stays in `contract.json`; C0/C1 are unchanged. C2 uses the exact
HubSpot scenario, actual accepted-response-readback witness and five independent
provider-collection assertions. Use a fresh output directory/session and retain
the configured contract before invoking the same existing MCP lifecycle. No
manual test-webhook arming or per-scenario controller is needed.

For the native negative-control run, `PILOT_VARIANT=blind-deal-retry`
generates an explicitly broken decision source. It changes every unknown-Deal
reconciliation into a second Deal POST; it does not inspect check IDs or fabricate
effects. The normal source is unchanged. The export guard accepts this source
only when that exact registered variant is explicitly selected. The business
assertions are not inverted or weakened. Publish/export and independently verify
the native version, measure its failing receipt, then restore and remeasure the
normal workflow. Never set an unobserved export to `active:true` to bypass setup.

Temporary twin sandboxes from both recorded runs were deleted, with four HTTP
200 responses per run. Their snapshots remained readable after cleanup. Receipts
are separate evidence; their passing totals must not be merged.

## Native C2 mutation measurement — November 7

The explicitly selected `blind-deal-retry` source was published as version
`4e0775d2-8ca2-448a-ba5f-721d53987021`, with a real six-node native export.
Execution 42 independently showed that version in n8n's history. It changes the
unknown-Deal reconciliation request to a second Deal POST; no check-ID branches
or oracle changes are involved. The adapter bundle and all 14 business checks
were identical to the preceding C3-positive run.

The separate negative receipt has four held checks, one violated (C2), and nine
unmeasured. Two Deal POSTs returned 201 with different IDs. FetchSandbox rejected
that behavior despite the application's own confirmed status. C0/C1 and both C3
checks still held. This is measured discrimination of the intended defect, not
proof of detecting every possible workflow error. Four owned twin sandboxes
were deleted and that failed receipt remained readable afterward.

## Normal source restored and remeasured

The [separate restored receipt](https://fetchsandbox.com/runs/03a3465a6f?flow=vr_139c4907d0e9400cab6879747ca74523)
held C0/C1/C2 and both C3 phases: five held, nine unmeasured, overall inconclusive.
Its 14 business checks exactly match the original C3 run and the negative run;
only native source/version metadata differs. The adapter bundle was unchanged.
Native executions 47–55 ran restored version
`064da74d-7ba5-4679-9d00-1efe7bb0b264`; pages 51 and 54 independently named it.
The archive contains one C2 Deal POST, and all 25 independent provider-state
assertions held. See [the restored observation](evidence/2026-11-07-normal-restored-observation.json).

The normal workflow is the published version. Its four owned twin sandboxes
were deleted, the receipt remained readable, the local adapter and temporary
ngrok/SSH forwarding were stopped, and the release candidate container was
stopped. No live provider deliveries were made. Three full-contract clean-seed
runs, remaining negative controls and fresh builder acceptance remain unmeasured.
