# C5: an accepted email remains unknown when lookup is unavailable

The [November 7 C5 receipt](https://fetchsandbox.com/runs/2e1288bcc5?flow=vr_20680065467a46948593bbe0c99e259d)
held C0/C1/C2, both C3 phases, C4 and this C5 unavailable-lookup case: **seven
checks held, seven unmeasured; overall inconclusive**. All 35 independent
provider-state assertions held. C0–C4 definitions were unchanged. See
[the sanitized observation](evidence/2026-11-07-c5-deployed-observation.json).

This is scripted MCP execution of the actual published n8n webhook with isolated
provider twins. It is not native Gmail delivery, native outage parity or fresh
builder acceptance. Empty and ambiguous read-back variants, a native deliberately
broken C5 control and the full quality milestone remain unmeasured.

## What happened

1. The Gmail twin committed one actual modeled message, then held the successful
   send response for ten seconds. The app's six-second client timeout occurred;
   the server archive retained acceptance and client disconnect separately.
2. The first n8n execution saved Gmail as unknown and Calendar as pending. The
   Contact and correctly associated Deal remained confirmed. Slack received an
   unknown-at-Gmail notification.
3. A second invocation tried message lookup. The exact
   `gmail.users.messages.list` operation returned the configured 503. The app
   stayed unknown; it did not resend the accepted email or create Calendar.
4. A third invocation used `retry_failed:true`. Unknown reconciliation took
   precedence over explicit failed-operation retry: another lookup returned 503,
   and the workflow again stayed unknown without downstream effects.
5. Independent provider-state assertions established one Contact, one associated
   Deal, **one accepted SENT message, zero Calendar events and three unknown
   Slack notifications**. CRM identities were preserved. The app kept the
   original send's client status 0; lookup 503s are archive observations, not a
   newly invented application-state field. Each unknown incoming execution posts
   a notification; this does not establish global Slack deduplication.

C5 executions 92–94 were observed in native history. Execution 94 independently
named normal version `03207059-cc93-4ab8-834e-bcb70e46b2ce`. The actual prior normal
export was reused for unchanged code and wiring. No native edit, new export,
manual webhook arming or laptop unlock was needed.

## Existing engine path and new configuration

Backend configuration release `8f2ee848` adds
`direct_send_accepted_lookup_unavailable` through the existing Gmail scenario
YAML: one post-commit delayed direct send plus unavailable message listing.
Default behavior is unchanged. This is a controlled transport/read-availability
experiment, not modeled provider eventual consistency. The twin retains real
modeled effects and adds no Message-ID deduplication.

Runtime image bytes are identical to the prior release. Of 260 configuration
files compared, only `gmail/scenarios.yaml` changed. Runtime environment values,
including the warm-sandbox setting, were preserved except build metadata.
Published MCP remains `0.7.30`; native decision source and adapter bundle are
unchanged. The existing `refusal` gate independently witnesses the unavailable
application lookup. Acceptance/disconnect are additional archive observations;
this C5 result is not an accepted-response-readback verdict, because the app
cannot read the accepted message while lookup is unavailable.

The verifier observes provider collections independently of the app's restricted
lookup. Its knowledge of the accepted message is never passed back as a recovery
hint. A separate operator-only component check uses the archived accepted ID to
read the retained message; that is component inspection, not application recovery.

## Qualification, failed attempts and limits

The missing-control test first failed. After the YAML addition, the relevant
backend gate passed 81 tests with one not-applicable parameter skipped. Workflow
tests passed 436 tests across 65 files; TypeScript passed. Private candidate and
public HTTP checks observed acceptance, real timeout/disconnect, repeated lookup
503s, retained message, default lookup restoration and an unsafe resend creating
a second message. Existing HubSpot relation/timeout and Gmail draft/direct/C3
rejection checks passed separately. These component results are not n8n receipts.

Two initial candidate probes could not connect because the SSH forwarding setup
was malformed; no candidate HTTP request was made. That setup was corrected and
its build endpoint verified before retry. The first promotion was rejected by
the environment drift guard: an older helper copied from another checkout would
omit `SANDBOX_WARM_SANDBOX_IDS`. Canonical `a952b218`, the original setting and
canonical routing were rechecked after the helper's restoration path. Promotion
then used the already committed helper from `864d2c54`, preserving the setting
without weakening the guard. Failed attempts are retained separately.

The run's four owned twins were deleted with HTTP 200 and its snapshot remained
readable. This does not satisfy the full C11 isolation contract. C4's native
negative control still needs the pending actual export saved after Mac unlock.
Source-capture automation is deferred. Single-process FileStore crash recovery,
multiple-worker behavior, full-contract repeatability and fresh native builder
acceptance remain separate requirements.

The measured local gate used these commands from the corresponding repository
root and the configured Python environment:

```sh
python -m pytest backend/tests/test_n8n_provider_fault_controls.py backend/tests/test_gmail_workflow_contract.py backend/tests/test_gmail_message_listing.py backend/tests/test_hubspot_deal_contract.py backend/tests/test_application_response_retry.py backend/tests/test_scenarios_change_behaviour.py -q
npm --prefix acme-ops run check
npm --prefix acme-ops test
```

Runtime repetition uses the standard `verify/relay-proof.mjs n8n-lead-recovery`
path with actual normal native export, private bindings, unchanged adapter bundle
and a fresh output directory/session. The frozen check is `C5` in `contract.json`;
its Gmail fault is `direct_send_accepted_lookup_unavailable`. Private archives
must stay private. Retain the receipt before deleting only that session's twins.
