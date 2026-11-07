# n8n lead recovery pilot — implementation in progress

This reference workflow addresses a lead automation that has partially completed:
CRM records exist, but an email failed or its outcome is unknown. A retry should
preserve completed work, and Calendar must wait for confirmed Gmail acceptance.
It was built from the prospective user's described flow, not their private code.
Owner: the configurable pilot operator, Sales Operations / lead intake team.

**C0, C1, C2 positive recovery and both C3 phases held on the published pilot.**
Backend `a952b218` and published MCP `0.7.30` produced this
[receipt](https://fetchsandbox.com/runs/63d0624d55?flow=vr_6e00ef2d5af44542b29056646591be18):
**five checks held, nine unmeasured; overall inconclusive**. C3 has separate
rejection/no-implicit-retry and explicit-recovery checks. All 25 independent
provider-state assertions held. Native executions 29–37 used the unchanged
published workflow; pages 34 and 36 independently named version
`abd2c751-c25e-459f-99c4-4616910156e6`.
See [the C3 proof](C3-PROOF.md) and [the observation](evidence/2026-11-07-c3-deployed-observation.json).

Subsequently, the [native C2 broken control](https://fetchsandbox.com/runs/57600c06f2?flow=vr_089aa5dd07534b45a9686a2c44403bb9)
failed on a duplicate Deal. The normal source was restored as version
`064da74d-7ba5-4679-9d00-1efe7bb0b264`; this
[separate post-restoration receipt](https://fetchsandbox.com/runs/03a3465a6f?flow=vr_139c4907d0e9400cab6879747ca74523)
held the same five checks with all 25 provider-state assertions. Nine requirements
remain unmeasured. See [the restored observation](evidence/2026-11-07-normal-restored-observation.json).


The full pilot and quality milestones remain open. Deliberately broken native
controls, full-contract repeatability and fresh builder acceptance are separate
requirements. C2's control work and historical failures are retained in
[C2-PROOF.md](C2-PROOF.md). Scripted runtime proof is not native SaaS parity.
Historical [C0/C1 evidence](evidence/2026-11-07-repeatable-c0-c1-observation.json)
and the original C0 workflow `XNOkSPCwhsCbH23J` remain separate observations.

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

The scripted MCP/runtime portion has measured C0/C1/C2/C3 results. The complete
builder acceptance journey, C4–C12, native deployed negative controls and three
clean repetitions remain unqualified. See [the acceptance and gap register](ACCEPTANCE.md).

## Published repeatable trigger — bounded cloud proof

The protected workflow `PJlTC5gnf6wb0r8e` is published with native Header Auth on
both network boundaries. Its observed version is
`abd2c751-c25e-459f-99c4-4616910156e6`; export SHA-256 is
`4b87079ad72a159484466dc6900ef270f8bedda9a28868fe1cb95367e553ef6b`.
The saved export matched six node types/versions/parameters, credential references
and wiring, with no pinned/disabled nodes. This replaced the earlier
[prepublication observation](evidence/2026-11-06-prepublication-observation.json).
The pilot remains published, but its temporary adapter and ngrok transport were
stopped after measurement. A fresh proof must start and bind them again.

The candidate uses the existing `verify/relay-proof.mjs` lifecycle, not another
verification controller. Its `verify/contracts/n8n-lead-recovery.mjs` module checks
that a native export is published, has no pinned/disabled nodes, protects both
network boundaries with native Header Auth references, and matches the app-owned
six-node source and wiring. The declared application version includes the exact
export SHA-256. This saved-export comparison still does not independently attest
that n8n executed that exact version at every instant.

The runner's optional app hooks prepare the same attempt's twin bindings and
protected startup health request. Existing workflows retain their default
runtime. FetchSandbox prepares the contract/session, executes through `/invoke`,
reads `/proof/{lead}`, independently checks provider collections and retains the
receipt through the existing MCP tools. C1 now has two deliveries of the same
lead and the same exact one-effect assertions; C2 is executable with accepted-response-readback evidence; C3 rejection and explicit recovery are executable; C4–C12 stay typed blocked. An
executable check is not a passing check.

The bridge accepts only the fixed persistent n8n URL and a private bearer value;
it refuses temporary/foreign URLs and redirects. It does not retry an ambiguous
invocation: a timeout may follow successful execution. The generated native
workflow contains credential references, not inline bearer values. Configure the
credential for the pilot n8n host and its specific adapter host only. It must not
contain customer/provider credentials. Header-authenticated application access
and the FetchSandbox MCP credential are separate boundaries.

After native credential setup and publication, export the actual saved workflow
privately. From `acme-ops`, with the existing n8n-to-adapter HTTPS transport ready:

```sh
node n8n-lead-pilot/build-adapter.mjs dist/lead-pilot.mjs
PILOT_BINDINGS_SOURCE=/private/pilot-bindings.json \
N8N_WORKFLOW_EXPORT=/private/published-n8n-export.json \
PROOF_BUNDLE=dist/lead-pilot.mjs PROOF_PORT=8097 \
node verify/relay-proof.mjs n8n-lead-recovery
```

The private source binding has `token` (adapter), `n8n_token` (native webhook) and
`n8n_webhook` (the fixed persistent URL). The workflow generator additionally
needs `n8n_header_auth: {id, name}` referencing the credential saved in n8n. The
runner writes session-specific `legs` into its private output directory; never
reuse an older session's legs. Do not print or commit these files. Each proof
still uses the standard protected verifier-token handoff.

Current evidence: 434 local tests passed across 65 files; TypeScript passed.
The compiled adapter startup check observed missing/wrong bearer 401, valid
health 200 and malformed input 400. Separately, the configured native n8n
webhook rejected missing/wrong headers with 403. Those checks do not complete C6.

### n8n MCP access and managed transport

n8n's MCP access can be a discovery/invocation surface; it is not FetchSandbox's
behavioral contract or verification engine. Native n8n MCP invocation has not
been enabled or qualified for this pilot. The measured path is FetchSandbox MCP
→ managed relay → protected local adapter → published n8n webhook. n8n Cloud
calls the adapter through separate protected ngrok HTTPS. Do not describe that
second transport as FetchSandbox managed-tunnel support or remove the adapter
from the measured architecture. The same contract and independent assertions
must apply before an alternate native MCP trigger can replace the webhook.

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

The earlier app checkpoint passed ten targeted state/mutation tests and TypeScript after
the Contact search request gained required paging/projection fields. The prior
broader checkpoint passed 415 tests; it is not a new full-suite run for this edit.
The deployed backend gate passed 1,344 tests, with two skipped and two expected
failures; native Gmail parity remains unmeasured. Native HubSpot qualification
covered only the documented bounded Deal subset and archived its own fixtures.

Current next steps after the November 7 C2 measurement:

1. C0/C1/C2 now execute through the protected published webhook without manual
   arming. Their separate failed and positive receipts are retained in
   [the C2 proof](C2-PROOF.md). Backend `33290a2d` and the final native run held all
   three, with fifteen independent provider-state assertions.
2. C2's native blind-retry negative control now failed its unchanged business
   checks with two distinct Deal IDs; see [the C2 proof](C2-PROOF.md). The normal
   source was restored and republished. Keep that negative receipt separate
   from normal runs and qualify the remaining mutations.
3. C3 rejection/no-implicit-resend and explicit recovery now held on backend
   `a952b218`; see [the C3 proof](C3-PROOF.md). Next qualify C4/C5
   response-loss and unavailable read-back through the actual workflow.
   Preserve unknown outcomes until positive read-back, never blind resend.
4. Reject deliberately broken variants under unchanged business assertions,
   then measure the full contract from three clean seeds with separate receipts.
   Qualify C6–C12 access/schema/concurrency/crash/privacy/cleanup/provider limits.
5. Retain actual published exports and observed native execution versions,
   contract/fixture hashes, rerun instructions and prospective-user acceptance.
   A saved export does not independently attest every runtime instant.

This is a published isolated test pilot. Native-provider parity, native vendor-node
acceptance, safe crash recovery and an all-case regression guarantee remain
unqualified.
