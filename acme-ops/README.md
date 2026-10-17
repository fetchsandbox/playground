# acme-ops

Nineteen ACME operations workflows across ten departments, each a **standalone Amazon Bedrock AgentCore
runtime**. Each runtime runs several agents in parallel across Zendesk,
HubSpot, Gmail, Stripe, Google Calendar and Slack. Each one speaks the
AgentCore HTTP contract (`POST /invocations`, `GET /ping` on `:8080`), so a
control plane such as LoopLabs can import it, start runs, approve gated
actions, read every agent's output and action, and reconcile what was written.

This package is the shared kit (engine, AgentCore server, provider clients, deploy infra, proof runner).
Each workflow is one file in `src/workflows/` plus its contract, receipt and tests, and ships in its own
PR; there is no central registry, so `WORKFLOW=<file name>` selects it at runtime and `cdk` adds one stack
per file.

| Workflow | Org · team | What it automates | Needs approval |
|---|---|---|---|
| [`support-escalation`](src/workflows/support-escalation.ts) | Support · support-ops | Triage a ticket against CRM, billing and the support lead's calendar; escalate, hold a callback, draft the reply | Public Zendesk reply |
| [`returns-warranty`](src/workflows/returns-warranty.ts) | Customer Experience · cx-service | Warranty check on the invoice, RMA task for the returns dock, RMA instructions draft | Credit / refund |
| [`order-status`](src/workflows/order-status.ts) | Customer Experience · cx-service | Answer "where is my order" from the invoice and warehouse task; alert the owner on late orders | Promise-date change |
| [`compliance-docs`](src/workflows/compliance-docs.ts) | Quality · quality-compliance | Find RoHS/REACH/CoC/calibration documents for a part, or route to Quality | External share link + reply |
| [`field-service-dispatch`](src/workflows/field-service-dispatch.ts) | Service · field-service | Site alarm: technician availability, contract coverage, work order, SMS to the site | After-hours or billable booking |
| [`rfq-quote`](src/workflows/rfq-quote.ts) | Sales · sales-ops | RFQ to priced Stripe quote under a discount policy; CRM and customer ensured | Discount above policy (finalize) |
| [`onboarding-kickoff`](src/workflows/onboarding-kickoff.ts) | Sales · sales-ops | Closed-won: CRM customer, Stripe customer, Zendesk org, welcome draft, Slack handoff | Subscription, kickoff invite |
| [`churn-risk-sweep`](src/workflows/churn-risk-sweep.ts) | Customer Success · cs-ops | Weekly risk score per account; digest, check-in drafts | QBR invites |
| [`service-renewals`](src/workflows/service-renewals.ts) | Customer Success · cs-ops | 90/60/30-day renewal sweep of monitoring and calibration contracts; tasks and drafts | Price uplift above policy |
| [`revenue-reconciliation`](src/workflows/revenue-reconciliation.ts) | Finance · revops-finance | Stripe payers vs HubSpot customers vs approved refunds; variance report | CRM fixes |
| [`collections-credit-hold`](src/workflows/collections-credit-hold.ts) | Finance · ar-collections | Tiered reminders for past-due invoices; AR digest | Credit hold |
| [`distributor-claims`](src/workflows/distributor-claims.ts) | Finance · channel-finance | Validate distributor claims against invoices, prices and agreement | Paying the credit |
| [`pcn-eol-notice`](src/workflows/pcn-eol-notice.ts) | Engineering · product-engineering | Product change / EOL record → affected customers and owners | Customer notices |
| [`export-screening`](src/workflows/export-screening.ts) | Trade Compliance · trade-compliance | Classification, embargo and restricted-party checks; hold the order when anything is unclear | Releasing a hold |
| [`supplier-ncr`](src/workflows/supplier-ncr.ts) | Quality · supplier-quality | Failed inspection → CAPA task, 8D request draft, review hold | Supplier hold notice |
| [`access-jml`](src/workflows/access-jml.ts) | IT · it-identity | Joiner/mover/leaver in the directory, IT ticket, manager notice | Privileged roles, leaver removal |
| [`license-reclaim`](src/workflows/license-reclaim.ts) | IT · it-asset-mgmt | Find idle seats, warn, reclaim after grace | Reclaim |
| [`security-questionnaire`](src/workflows/security-questionnaire.ts) | IT · it-security | Answer from the approved library, flag new questions to Security | Sending answers |
| [`incident-comms`](src/workflows/incident-comms.ts) | IT · it-operations | PagerDuty incident → note, war-room post, affected customers | Customer notices |

Design rules shared by all nineteen:

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

The original branch receipts reported 251 held checks and 25 unmeasured checks. Those historical
results are not a claim about the current production service. The October 17 production revalidation
has baseline failures where the Google Calendar twin returns `501 not_simulated` for `freeBusy`,
as well as explicit unmeasured checks. Read the individual current receipts and their recorded
versions; do not combine separate runs into one proof. A contract that includes unmeasured or
violated checks is not fully verified. A relay test also does not establish native-provider or
AgentCore end-to-end behavior.

Per-check results, receipt links and the twin findings: run `node verify/results.mjs`, which renders
`verify/RESULTS.md` from the receipts in `verify/receipts/` (one per workflow, committed with it).

## Deploy (one AgentCore runtime per workflow)

```bash
AWS_PROFILE=<deployment-profile> npx cdk deploy --all \
  -c sourceCommit=$(git rev-parse HEAD) \
  -c approverUserIds=<named-approver-user-id>
# or one: npx cdk deploy AcmeOps-churn-risk-sweep   (19 stacks: AcmeOps-<workflow>)
# JWT instead of IAM: -c jwtDiscoveryUrl=https://idp.example.com/.well-known/openid-configuration -c jwtAllowedClients=looplabs
```

Each stack (`AcmeOps-<workflow>`, tagged `acme:org` / `acme:team` /
`acme:workflow`) creates an ARM64 AgentCore runtime, a DynamoDB state table, a
Secrets Manager secret and X-Ray tracing. If you pass `looplabsAccountId`, it
also creates a role LoopLabs assumes to call `InvokeAgentRuntime`. Put the
provider keys from [`.env.example`](.env.example) into each stack's `SecretArn`.

Do not pass `looplabsAccountId` for an observation-only installation. A newly created secret
initially contains a generated string; replace it with the required provider JSON before invoking
the runtime. Preserve existing workflow secrets and state tables during updates. Google and
Zendesk support renewable OAuth credentials on their native hosts; custom/twin endpoints retain
their own temporary credentials. Configure log retention explicitly.

When the regional X-Ray policy quota is exhausted, first verify a shared policy already grants
`delivery.logs.amazonaws.com` the required account/region-scoped AgentCore trace access. Only then
deploy with `-c useExistingTraceDeliveryPolicy=true`. This retains trace delivery while omitting
redundant per-stack policies; it does not create or widen the shared permission. Keep the default
when no equivalent policy exists.

## Known gaps

- **Zendesk coverage**: production MCP now discovers a bounded Zendesk twin. The original
  contracts exclude Zendesk and retain historical "no twin" explanations. Those declarations do
  not prove current discovery is broken, nor do they verify Search, user/organization provisioning,
  or public replies. Reassess each required operation before refreshing the contracts.
- **Google Calendar availability**: current production `freeBusy` is not simulated; baseline
  failures and checks skipped after those failures remain explicit in their receipts.
- **Deployment versus application verification**: AgentCore deployment, manifest checks,
  relay contracts, and live provider actions are separate gates. Record the exact runtime version
  and result for each. These runtimes expose IAM-authenticated `/invocations`; this package does
  not itself install native Slack listeners, Gmail watches, or schedules.
