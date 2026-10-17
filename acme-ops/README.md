# acme-ops

Four ACME operations workflows, each a **standalone Amazon Bedrock AgentCore
runtime**. Each runtime runs several agents in parallel across Zendesk,
HubSpot, Gmail, Stripe, Google Calendar and Slack. Each one speaks the
AgentCore HTTP contract (`POST /invocations`, `GET /ping` on `:8080`), so a
control plane such as LoopLabs can import it, start runs, approve gated
actions, read every agent's output and action, and reconcile what was written.

| Workflow | Org · team | Parallel agents | Auto actions | Needs approval |
|---|---|---|---|---|
| [`support-escalation`](src/workflows/support-escalation.ts) | Support · support-ops | ticket triage (Zendesk) ‖ account context (HubSpot) ‖ billing health (Stripe) ‖ callback availability (Calendar) → reply composer | Zendesk priority/tags/internal note, Slack escalation, Calendar callback hold (no attendees), Gmail reply **draft** | Public Zendesk reply |
| [`revenue-reconciliation`](src/workflows/revenue-reconciliation.ts) | Finance · revops-finance | Stripe ledger ‖ HubSpot ledger ‖ Zendesk refund approvals → reconciler | Variance report to Finance Slack | HubSpot `lifecyclestage=customer` fixes |
| [`churn-risk-sweep`](src/workflows/churn-risk-sweep.ts) | Customer Success · cs-ops | billing (Stripe) ‖ engagement (HubSpot) ‖ support (Zendesk) ‖ inbox (Gmail) ‖ CSM availability (Calendar) → risk scorer | CS digest in Slack, check-in **drafts** | QBR invites (send calendar invitations) |
| [`onboarding-kickoff`](src/workflows/onboarding-kickoff.ts) | Sales · sales-ops | CRM check ‖ billing check ‖ support check ‖ kickoff scheduler → welcome composer | HubSpot customer, Stripe customer (no charge), Zendesk org/requester, welcome **draft**, Slack handoff | Stripe subscription (bills), kickoff invite |

Design rules shared by all four:

- **Agents read; actions write.** Agents gather and judge in parallel. Every
  side effect is a planned, named action with a gate (`auto` or `approval`), a
  summary for the approval card, and an optional read-back for reconciliation.
- **Models write words; code makes decisions.** Claude (`claude-opus-5-5`,
  when `ANTHROPIC_API_KEY` is set) drafts replies, briefs and check-ins.
  Severity, risk scores, ledger matching, prices, recipients and gating are
  all computed in code. Customer-facing mail is created as a Gmail *draft*.
  Without a key, deterministic templates are used and `draftedBy: "template"`
  says so.
- **Nothing is faked.** A provider with no credentials is *not configured*. Its
  agents are `skipped` and its actions are recorded as `skipped / not_configured`.
- **Independent.** Each runtime has its own image (`--build-arg WORKFLOW=…`),
  its own DynamoDB table and its own secret. They share source code, not state.

## Control API (`POST /invocations`)

| Command | Fields | Returns |
|---|---|---|
| `describe` | — | Owner org and team, agents and the providers they need, every action kind with its gate, input JSON Schema |
| `start` | `runId?` (idempotency key, e.g. the trigger's event id), `input`, `requestedBy {userId}`, `labels?`, `wait?` (default `true`) | Run view. Repeating a `runId` returns the existing run with `duplicate: true` and bumps `duplicateStarts` |
| `status` | `runId` | Run view |
| `decide` | `runId`, `decision: approve\|reject`, `userId` | `result`: `recorded`, `already_decided`, `forbidden` (HTTP 403), `expired`, `not_ready`, `closed` |
| `cancel` | `runId`, `userId` | `cancelled` (while awaiting approval), `cancelling` (mid-flight), `not_cancellable` |
| `resume` | `runId` | Continues a stalled run from its last checkpoint, or retries failed effects of a parked or finished run |
| `reconcile` | `runId` | Re-reads every applied effect from its provider and records `match`, `drift`, `missing` or `unverifiable` per action |

The **run view** is the control plane's single source of truth:

```jsonc
{
  "runId": "zd-4242", "workflow": "support-escalation", "org": "Support", "team": "support-ops",
  "phase": "AWAITING_APPROVAL",            // RUNNING → AWAITING_APPROVAL → APPROVED → DONE | REJECTED | EXPIRED | CANCELLED
  "outcome": "partial",                    // ok | partial | failed | pending
  "agents":  [{ "name": "billing-health", "status": "failed", "errorCode": "stripe:api_key_invalid", "durationMs": 212 }, …],
  "actions": [{ "id": "slack.post_escalation", "provider": "slack", "gate": "auto", "status": "applied", "ref": "1792…", "attempts": 1, "reconciled": null },
              { "id": "zendesk.public_reply", "gate": "approval", "status": "pending_approval", "summary": { "preview": "Hi Alice, …" } }, …],
  "approval": { "approvers": ["U_LEAD"], "expiresAt": "…" },
  "counts":   { "applied": 3, "failed": 0, "pendingApproval": 1, "skipped": 1, "rejected": 0 },
  "output":   { "severity": "urgent", "escalated": true, … },
  "duplicateStarts": 0, "events": [ … ]
}
```

### How runs stay correct

| Situation | Handling |
|---|---|
| Trigger delivered twice or concurrently | `start` is a put-if-absent on `runId`. Later deliveries return the same run (`duplicateStarts` counts them) |
| One provider down or refusing | That agent becomes `failed` with a typed `errorCode` (e.g. `slack:channel_not_found`) and the rest carry on. Reconciliation refuses to compare against a ledger it couldn't read |
| Retried or concurrent side effect | Each effect is claimed in the store (`effect#run#action`) before it runs and records its receipt. A retry copies the receipt instead of repeating the effect. Stripe customers are looked up at write time, because the twin ignores `Idempotency-Key` |
| Re-fired business event (e.g. closed-won twice) | Plans read current provider state: an existing live subscription to the same price means no new subscription is proposed, and the approval step re-checks before creating one |
| Crash or redeploy mid-run | Every phase is a compare-and-swap checkpoint in DynamoDB. `resume` continues from it without re-running finished agents or applied effects |
| Approval races, strangers, late clicks | One conditional `AWAITING_APPROVAL → APPROVED/REJECTED` wins, others get `already_decided`. Non-approvers get `403 forbidden`. Approvals expire after `APPROVAL_TTL_HOURS` |
| Things changed after we wrote them | `reconcile` re-reads HubSpot contacts, Stripe customers and subscriptions, Zendesk tickets and Calendar events, and reports drift (e.g. seats changed by hand) |
| Prompt injection via tickets or emails | Customer text only reaches the drafter, wrapped as untrusted `<facts>`. Drafts are never sent automatically, and Slack text is stripped of markup |

## Run locally

```bash
cd acme-ops
npm install
npm test                       # tests: duplicates, races, faults, approvals, expiry, restart, resume, reconcile, HTTP contract
npm run bundle
WORKFLOW=onboarding-kickoff STATE_FILE=.state/runs.json node --env-file=.env dist/main.mjs
curl -s localhost:8080/invocations -d '{"action":"describe"}'
```

## Prove it against FetchSandbox twins (managed relay)

`verify/relay-proof.mjs <workflow>` runs the **real container entry point** on
a loopback port and proves it through FetchSandbox's managed relay:

1. `manage_tunnel open` exposes the runtime to the verifier only. No ngrok is
   needed, and direct requests get a 404.
2. `validate_integration { providers, app_base_url }` creates isolated twins.
   The runtime is restarted with each provider's `<P>_BASE_URL` / `<P>_API_KEY`
   pointed at them.
3. `application_workflow_v1` is configured from
   [`verify/contracts/<workflow>.mjs`](verify/contracts). Every action is the
   runtime's own `POST /invocations`. Every observation reads saved run state
   from `GET /verify/runs/{run}/cases/{case}/runs`, which is bearer-protected
   by the verifier token and exists only when `FETCHSANDBOX_VERIFIER_TOKEN` is
   set. AgentCore never routes it.
4. `install_test_credentials` writes the private handoff file. It's loaded with
   `node --env-file` and never read or printed. `X-Flow-Run-Id` is stamped on
   every provider call.
5. Preflight, execute once, poll the same run. The receipt goes to
   `verify/receipts/<workflow>.json`.

```bash
npm run bundle
node verify/relay-proof.mjs support-escalation
```

Each contract covers the happy path and approve, reject and stranger-approval
paths. It also covers duplicate and 4× concurrent triggers, input
validation, and provider faults armed on the twins (auth failures, rate
limits, Slack `channel_not_found` / `not_in_channel`). All 17 FetchSandbox
coverage dimensions are reviewed. Anything that can't be exercised yet is
declared as a **blocked** check with evidence, never dropped.

### Results

All four runtimes were proven at commit `dbab6f7`. **54 of 54 executable checks held**, each
driven twice with identical saved state, and each including a real process restart. The one
Zendesk check per workflow is declared blocked until a Zendesk twin exists, so FetchSandbox
reports the overall verdict as *inconclusive* rather than *verified*. The proof also caught a
real bug (a re-fired closed-won trigger could create a second subscription while the first was
still `incomplete`), which is fixed and regression-tested.

Per-check results, receipt links and the twin findings are in [`verify/RESULTS.md`](verify/RESULTS.md).

## Deploy (one AgentCore runtime per workflow)

```bash
npx cdk deploy --all \
  -c looplabsAccountId=111122223333 -c looplabsExternalId=<shared-secret> \
  -c approvers:onboarding-kickoff=U_RVP -c approvers:revenue-reconciliation=U_CONTROLLER
# or one: npx cdk deploy AcmeOps-churn-risk-sweep
# JWT instead of IAM: -c jwtDiscoveryUrl=https://idp.example.com/.well-known/openid-configuration -c jwtAllowedClients=looplabs
```

Each stack (`AcmeOps-<workflow>`, tagged `acme:org` / `acme:team` /
`acme:workflow`) creates an ARM64 AgentCore runtime, a DynamoDB state table, a
Secrets Manager secret and X-Ray tracing. If you pass `looplabsAccountId`, it
also creates a role LoopLabs assumes to call `InvokeAgentRuntime`. Put the
provider keys from [`.env.example`](.env.example) into each stack's `SecretArn`.

## Known gaps

- **Zendesk twin**: FetchSandbox doesn't have one yet. The Zendesk client
  ([`src/providers/zendesk.ts`](src/providers/zendesk.ts)) uses Zendesk's own
  REST v2 paths, so it will run against the twin once it exists (set
  `ZENDESK_BASE_URL`). Until then the Zendesk checks are declared blocked.
- **Not yet deployed to a live AWS account.** Verified with tests, `cdk synth`
  and the twin proofs. The Docker image wasn't built here.
