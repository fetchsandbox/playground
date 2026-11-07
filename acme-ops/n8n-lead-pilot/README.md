# n8n lead recovery pilot — implementation in progress

This reference workflow addresses a lead automation that has partially completed:
CRM records exist, but an email failed or its outcome is unknown. A retry should
preserve completed work, and Calendar must wait for confirmed Gmail acceptance.
It was built from the prospective user's described flow, not their private code.
Owner: the configurable pilot operator, Sales Operations / lead intake team.

**Current full-flow acceptance is blocked.** The hosted HubSpot twin exposes
Contacts, not Deals. The actual n8n Cloud run created a contact, received 404 on
Deal creation, held Gmail/Calendar, and posted a failure to the Slack twin.
Replaying that lead preserved the contact ID. See
[the dated observation](evidence/2026-11-06-observation.json).
Node execution success does not mean the business workflow succeeded.

## Design and scope

`Lead webhook → validate input → decision machine → conditional state / twin I/O
→ decision machine → return confirmed, failed or unknown`

The decision machine is embedded in an n8n Code node; all network calls use an
HTTP Request node. These are **not native HubSpot/Gmail/Calendar/Slack nodes**.
There is no LLM step, LoopLabs dependency, live email, calendar invitation or
Slack delivery. Dummy identities use reserved `example.com`; the native HubSpot qualification rejected `.test` addresses. There are no payment actions.

The trigger accepts `lead_id` (1–100 ASCII letters, digits, `_` or `-`) and an
explicit `retry_failed` boolean. The n8n execution ID is the attempt identity.
The lead ID is the business key; it must not change when retrying the same lead.
This single-operator pilot does not establish production tenant isolation.

Policy version: `machine.mjs` source digest. Calendar is eligible only after
`gmail.status=confirmed`. An email timeout is `unknown`, never proof of failure.
The Deal create request names the saved Contact ID. A successful create response
alone does not release Gmail: a Deal read must confirm that same ID under its
Contact associations. A wrong/missing association holds the flow as unknown.
Unknown Gmail sends require a positive read-back matching SENT, Message-ID and
recipient. Empty/unavailable/ambiguous read-back leaves the operation unknown.
There is no automatic resend on unknown, and no approval/decline policy in scope.
Slack receives lead ID, outcome and blocked step. Slack failure is reported as
an unconfirmed notification, separately from the saved workflow outcome.

`state.ts` reuses the existing `KvStore` abstraction: atomic create for a claim,
version compare-and-swap for checkpoints. Operation state and returned resource
IDs are saved before continuing. The temporary adapter uses **one FileStore
process**. It is not safe for multiple independent processes sharing the file;
production must qualify the existing DynamoStore or another conditional store.
FileStore reconstruction was tested; crashing a live n8n execution and safely
recovering an abandoned `in_progress` claim remains unimplemented/unmeasured.

`adapter.ts` owns no orchestration decisions. It exposes authenticated state
commands and a bounded allowlist of requests to owner-session FetchSandbox twin
URLs. It refuses arbitrary hosts. Its `/invoke` and `/proof/{lead}` routes are
test adapters for the existing `application_workflow_v1` verifier. Never add
customer credentials or expose this test adapter as a production service.

## Local checks and isolated setup

From `acme-ops`:

```sh
npm ci
npm run check
npm exec vitest run test/n8n-lead-state.test.ts test/n8n-lead-mutation.test.ts
npm test
```

Nine new tests cover competing first claims, file reconstruction with retained
IDs, stale-write rejection, replay identity, known rejection versus unknown,
Calendar withholding, Deal/Contact identity and positive Gmail read-back identity. The mutation test
deliberately forgets completed claims: the same one-effect oracle rejects its
two-effect outcome and accepts the corrected policy. Provider responses in that
unit test are stubs. **It is not a FetchSandbox or n8n receipt.**

Cloud setup uses the current [FetchSandbox MCP](https://fetchsandbox.com/mcp)
tool schemas to create a four-provider disposable session. Inspect the actual
operations first. Save its `legs` and a fresh test-only bearer token privately as
`PILOT_BINDINGS`; keep all generated exports with tokens outside version control.
Build `adapter.ts` with the repository's esbuild tooling. Bind a private
`STATE_FILE` and `TRACE_FILE`, and a loopback port (measured pilot used 8097).
The temporary adapter requires a reachable HTTPS origin for n8n Cloud.

```sh
PILOT_BINDINGS=/private/bindings.json node n8n-lead-pilot/build-workflow.mjs \
  https://YOUR-PROTECTED-TEMPORARY-ORIGIN YOUR-UNIQUE-TEST-WEBHOOK \
  /private/workflow.json
```

Import that generated file into a **new** n8n workflow. Do not modify existing
workflows. Use the test webhook listener and inspect the returned business
status. The n8n draft tested on November 6 is not published. Tokens in its private
HTTP-node binding authorize only this disposable adapter, not live providers.

FetchSandbox's managed relay explicitly accepts verifier traffic only. It cannot
serve as the n8n Cloud → local state-adapter connection. The measured pilot used
an existing ngrok installation for that separate connection. Do not describe this
as n8n executing over the managed relay. Close both temporary tunnels and stop
the adapter after recording evidence; retain state and sanitized observations.

## Frozen acceptance and remaining work

[contract.json](contract.json) retains a full-flow baseline requiring confirmed
contact, deal, Gmail and Calendar. It must not be weakened to call Contacts-only
execution a pass. C1–C5 remain explicitly blocked/unmeasured. The private evidence
directory retains HTTP outcomes, twin traces, independent MCP read-back and the
initial n8n `structuredClone` failure, corrected using JSON cloning.

The later Deal-association guard and native-derived fixture-domain change are local-only as of this checkpoint; the saved
cloud draft has not been updated or remeasured with it. The new local test and
full Acme suite passed (414 tests). Existing cloud observations remain historical
evidence for their measured revision and are not silently reassigned to this one.

1. Add and qualify HubSpot Deal create/read/search in the curated twin, including
   actual Contact/Deal association and identity-sensitive independent read-back.
   Existing source is Contacts-only in `backend/specs/hubspot/openapi.yaml` and
   `backend/configs/hubspot/sandbox_config.yaml`; generic search support already
   exists. Extend the current engine, not a second CRM emulator.
2. Qualify each agreed fault at its encountered operation. Hosted Gmail's
   `send_unavailable` advertises `drafts.send`, while this flow calls
   `messages.send`; do not claim that scenario exercises this send path.
3. Execute C0–C5 in real n8n with independent provider assertions, then reject the
   duplicate, blind-retry, Calendar-on-unknown and mislabeled-outcome defects.
4. Rerun the same frozen checks against the corrected export from three clean
   seeds. Save separate receipt URLs and exact workflow/contract/fixture hashes.
5. Retrieve the saved native export, reopen evidence after stopping the sessions,
   then give the prospective user rerun instructions and record their acceptance.

No live-provider parity, native vendor-node acceptance, restart recovery, all-case
regression guarantee, or production deployment is established by this pilot.
