# Verify a workflow before relying on it

The goal is to show what the app actually did: which customer was affected,
which records changed, which action was withheld and whether a retry repeated an
effect. A model-generated summary or HTTP 200 is not that proof.

## Connect and establish scope

Use the current [FetchSandbox MCP installation instructions](https://fetchsandbox.com/mcp)
for your client and authenticate with your own FetchSandbox account when required.
Root `.mcp.json` and `.cursor/mcp.json` declare the same key-free server, pinned to `0.7.30` for reproducibility, matching the Acme runner. Your client may ask you to trust/enable the workspace server. Node/npm and `npx` must be on the client process PATH; if not, follow the published platform-specific install instructions and use your local executable path in an uncommitted user configuration. Never commit a machine-specific absolute path. Authentication uses your private environment or FetchSandbox credential store.

Confirm the server connects and inspect its tool list. Repository instructions
are not a connector installation or permission grant. Do not paste keys in a PR,
chat transcript, committed `.mcp.json` or evidence file. Do not assume an `npx`
configuration works on every machine; use the published setup for your environment.

Choose one workflow in [the catalog](WORKFLOWS.md). Read its input schema,
provider clients, decision rules, agent responsibilities and action gates. The
coding agent that owns that app defines the intended business contract;
FetchSandbox supplies discovered twin/fault/fixture/observation capabilities and
records execution evidence. An LLM proposal does not establish correctness.

For each behavior, define the trigger, initial data, permitted effect, forbidden
effect and independent saved-state observation. Link the relevant agent/provider
and assertion to a check ID. Test the workflow end to end, not only its agents in
isolation. A read-only research role and an approval-controlled writer have
different expectations. Unsupported business features stay outside app scope;
missing verification machinery remains an explicit engine/setup gap.

## Existing Acme runner

Requires Node 22+, package dependencies, an authenticated FetchSandbox account at
`~/.fetchsandbox/credentials.json`, and managed-relay access. Inspect
`acme-ops/verify/relay-proof.mjs` for its pinned MCP version and credential flow.
Do not hand-edit disposable keys into source. Run from a private workstation:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
node verify/relay-proof.mjs support-escalation
```

Replace the workflow name with the selected guide. The runner launches the real
local app, binds twin provider URLs, configures its contract and observes saved
state through the managed relay. It uses network resources and FetchSandbox
usage. Read the resulting receipt and exit status; command completion alone is
not a pass. Do not run parallel proofs sharing a state file, port or credentials.
The repository's private verifier endpoints must remain authenticated and must
not be exposed by a production AgentCore routing adapter.

For another package, follow its documented runner. If it has none, inspect the
app and returned MCP schemas and build a scoped contract/adapter; do not silently
reuse the Acme contract for a different API. Record the missing runner explicitly.

## Scenarios and evidence

| Risk | Evidence to require when relevant |
|---|---|
| Identity/tenant ownership | Allowed requester succeeds; another customer cannot change the resource |
| Business policy | Boundary inputs produce the intended automatic, approval, decline or clarify decision |
| Approvals | No gated effect before approval; authorized decision continues; stranger/reject/expiry stays withheld |
| Duplicate/replay | Stable event/run identity and one saved effect after redelivery |
| Concurrency | Concurrent **first** deliveries, separately from replaying an already-completed run |
| Provider failures | Arm an encountered operation; observe refusal, partial effects and recovery |
| Lost response | Prove the provider accepted the effect, then recovery reads it without a second effect; otherwise unmeasured |
| Restart | Restart the actual process with the same storage; observe original pending state and continuation |
| Reconciliation | Read the actual provider record/balance and compare it to the expected app state |
| Communication | Distinguish draft, accepted send, simulated mailbox and real recipient inbox |

Do not force irrelevant checks into a workflow. Preserve relevant but currently
unmeasured cases and their exact blocker. A twin test does not prove live OAuth
consent, actual SMTP delivery, all enterprise permissions or an installed Slack
trigger. Record those as separate acceptance exercises.

## Results and publication

Keep sanitized artifacts with workflow ID, app commit/version, contract path or
hash, MCP/backend version when observed, exact test command, counts by status,
receipt URL and scope limits. Disclose fixture and assertion changes. Use
`acme-ops/verify/receipts` for that package's established result format; another
package can provide a sanitized verification record linked from its guide.

Every PR must identify affected business behavior and either link fresh relevant
proof or state the exact blocker/not-run reason. Documentation-only changes run
`python3 scripts/workflow_docs.py --check` and the local link checker. CI verifies
documentation consistency; it does not enforce that every coding client loaded
instructions, and it does not convert old or unmeasured receipts into passes.
