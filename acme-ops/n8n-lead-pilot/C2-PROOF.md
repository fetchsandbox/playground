# C2: recover a HubSpot Deal after its accepted response is lost

The normal published n8n workflow has passed C2, together with unchanged C0 and
C1 checks, in this [measured receipt](https://fetchsandbox.com/runs/2bf995e8ee?flow=vr_7b4d8b1954a24a49a1246317b363a6ca).
It is **inconclusive overall: three held, ten unmeasured**. This run used backend
`33290a2d`, published MCP `0.7.30`, native workflow `PJlTC5gnf6wb0r8e`, observed
native version `abd2c751-c25e-459f-99c4-4616910156e6`, and the export/bridge hashes
recorded in the receipt. Native execution history independently showed C2's
first and recovery executions as 27 and 28 under that version.

The full C2 quality milestone remains open: the native deliberately broken
workflow control has not run. Its versioned source is locally tested; native
export/publication is pending Mac access. It must fail under the same corrected
business assertions before this milestone is called closed. A local negative
control is not that native workflow receipt.

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

For the future native negative-control run, `PILOT_VARIANT=blind-deal-retry`
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
