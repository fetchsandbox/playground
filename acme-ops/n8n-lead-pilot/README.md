# n8n lead recovery pilot — implementation in progress

This reference workflow addresses a lead automation that has partially completed:
CRM records exist, but an email failed or its outcome is unknown. A retry should
preserve completed work, and Calendar must wait for confirmed Gmail acceptance.
It was built from the prospective user's described flow, not their private code.
Owner: the configurable pilot operator, Sales Operations / lead intake team.

**C0 passed; the full pilot remains incomplete.** Backend `fdd1d243` is
publicly deployed with bounded HubSpot Deal create/read/search and Gmail
sent-message lookup. Actual n8n execution 10 was driven by the existing verifier;
its C0 baseline and five independent provider-collection assertions held. The
[receipt](https://fetchsandbox.com/runs/f320278d1a?flow=vr_1e3ff3dcbf0c4dbba9f04e1f7a760212)
is **inconclusive overall: one passed, twelve not checked**. See the
[sanitized observation](evidence/2026-11-06-c0-verifier-observation.json).
The saved workflow `XNOkSPCwhsCbH23J` remains unpublished. Earlier Deal-404 and
helper/schema failures are retained, including the
[original cloud observation](evidence/2026-11-06-observation.json).

## Required builder-to-verifier pattern — Raj, November 6, 2026

This pilot must follow the same MCP development loop as an app built in Claude
or Replit. The app/workflow builder agent owns the application and talks to
FetchSandbox MCP. n8n is the application runtime; it does not need a second
verification engine or a separate hand-written verification controller.

One user request starts a multi-turn MCP interaction:

1. The builder inspects the actual saved workflow, intended business behavior,
   provider operations, state, identities and public test entry points. It submits
   that bounded context through the existing `validate_integration` interface.
2. The builder and FetchSandbox develop the behavioral contract: the happy path,
   Friendly's explicit requirements, and every applicable default production-risk
   dimension. Friendly should not have to enumerate standard failure scenarios.
   The model may propose rules; deterministic observations own the verdict.
3. Freeze the reviewed checks and workflow version before execution. Bind isolated
   twins through the protected credential handoff. Qualify faults against the
   exact provider operations the saved workflow calls, not a nearby API operation.
4. FetchSandbox drives the authenticated, repeatable n8n entry point from beginning
   to end. It orchestrates applicable inputs, duplicates, concurrency and qualified
   faults through the existing `application_workflow_v1` executor. It checks saved
   app state and provider effects independently, then persists the receipt. The
   builder follows the same job until its result and handles setup/continuations;
   no manual webhook arming or human per-scenario triggering in the target flow.
5. If a rule fails, the builder fixes the application and remeasures under the
   same frozen contract where feasible. If setup or assertions change, preserve
   the earlier receipt and identify the changed contract. Never silently weaken
   an invariant or treat an HTTP 200 / workflow success badge as business proof.

Default risk review includes applicable identity/input boundaries, duplicate and
concurrent delivery, timeouts and accepted-but-response-lost outcomes, provider
rejection/rate limits, partial completion and recovery, restart/durability,
privacy and cleanup. Irrelevant dimensions need an explicit reason. Missing
engine capability, safe trigger, fault control or evidence must remain a typed
blocked/unmeasured check; 'defaults included' does not mean unsupported scenarios
were executed or every possible production failure is covered.

Friendly-specific invariants include preserving completed CRM effects, verifying
the exact Deal/Contact relationship, reconciling unknown email outcomes without
blind resend, withholding Calendar until email confirmation, and exposing the
blocked operation accurately in Slack.

Acceptance for the next integration milestone: from one builder request, MCP
contract preparation, protected twin binding, preflight, actual repeatable n8n
execution and receipt retrieval proceed without manually arming a test webhook.
Retain workflow/contract hashes and separate failed/control receipts. Then make
C1–C12 executable where supported, reject deliberately broken variants and run
three clean repetitions. Do not require a new customer prompt to discover the
applicable default risks.

This section records the required design, not shipped capability. Current proof
remains C0 only on backend `fdd1d243`; the draft is unpublished, C1–C12 remain
unmeasured, and the end-to-end builder experience above has not been qualified.

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

Ten new tests cover competing first claims, file reconstruction with retained
IDs, stale-write rejection, replay identity, known rejection versus unknown,
Calendar withholding, Deal/Contact identity and positive Gmail read-back identity. The mutation test
deliberately forgets completed claims: the same one-effect oracle rejects its
two-effect outcome and accepts the corrected policy. Provider responses in that
unit test are stubs. **It is not a FetchSandbox or n8n receipt.**

Cloud setup uses the current [FetchSandbox MCP](https://fetchsandbox.com/mcp)
tool schemas to create a four-provider disposable session. Inspect the actual
operations first. Save its `legs` and a fresh test-only bearer token privately as
`PILOT_BINDINGS`; keep all generated exports with tokens outside version control.
Build the current adapter with dependencies included; retain the adjacent source/bundle hash manifest and verify authenticated `/ping` before arming n8n. A stale helper previously rejected Deal GET, and an external-only bundle failed to start. Do not reuse an unverified old bundle.

```sh
node n8n-lead-pilot/build-adapter.mjs /private/adapter.mjs
```

Bind a private
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

[contract.json](contract.json) requires exact identities and counts across Contact,
Deal, Gmail, Calendar and Slack, plus saved positive Deal read-back and Slack
acceptance. C0 held in the November 6 run; C1–C12 remain typed blocked/unmeasured.
The prior receipt stopped on an unrelated seed event without attendees. The
[selector calibration](evidence/2026-11-06-calendar-selector-calibration.json)
retains every target identity/count requirement: missing/wrong attendee, wrong
ID, duplicate attendee and duplicate target fail. The historical receipt remains
inconclusive and is not relabeled as passing.

The measured verifier run used the existing authenticated HTTPS/ngrok adapter.
Managed relay capacity was unavailable after helper restart; neither the n8n
Cloud transport nor this receipt establishes managed-relay acceptance. After the run, eight owned modeled sandboxes were deleted and the owner snapshot
and public receipt reopened with C0 still held. Temporary helpers, forwarding
ports and protected handoff files were closed/removed. This operational cleanup
does not mark the separately declared C11 as measured. The saved
Code node was read back after reload and matched local source. The complete
native workflow export was subsequently downloaded after Mac unlock and compared
with the reference: all six node types/versions and parameters match, allowing
only an added empty webhook `options` object; connections match, no nodes are
pinned or disabled, and `active=false`. See the
[native export observation](evidence/2026-11-06-native-export-observation.json)
for the SHA-256 and exact comparison. This is saved-source inspection after the
run, not immutable attestation of the historical executed source. The original
receipt and its declared-version limitation remain unchanged.

The current app passed ten targeted state/mutation tests and TypeScript after
the Contact search request gained required paging/projection fields. The prior
broader checkpoint passed 415 tests; it is not a new full-suite run for this edit.
The deployed backend gate passed 1,344 tests, with two skipped and two expected
failures; native Gmail parity remains unmeasured. Native HubSpot qualification
covered only the documented bounded Deal subset and archived its own fixtures.

1. Qualify a repeatable authenticated test trigger and C1 duplicate delivery.
2. Qualify operation-specific C2–C5 faults. Hosted Gmail `send_unavailable`
   advertises `drafts.send`, while this flow calls `messages.send`; do not claim
   that scenario exercises this send path. Preserve accepted-but-response-lost
   outcomes as unknown until exact positive read-back, never blind resend.
3. Execute deliberately broken variants and reject duplicate effects, blind retry,
   Calendar-on-unknown and mislabeled outcomes using the same frozen checks.
4. Run the corrected C0–C5 contract from three clean seeds with separate receipts.
   Qualify C6–C12 access/schema/concurrency/crash/privacy/cleanup/provider limits.
5. The complete saved export has now been retained privately with its hash and
   comparison; receipts reopened after cleanup. Tie a future full fault run to
   its exact exported workflow/contract/fixture hashes, then provide rerun
   instructions and record the prospective user's acceptance.

No live-provider parity, native vendor-node acceptance, safe crash recovery,
all-case regression guarantee or production n8n deployment is established here.
