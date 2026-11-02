# Adopting an Acme workflow

This guide takes one workflow from the catalog to a runtime you operate: read
it, connect your own provider accounts, run it locally, adapt its policy, wire
its trigger, deploy it to AWS, and verify it. Every workflow in
[`acme-ops`](../acme-ops) follows the same steps.

> These are reference implementations under the [MIT license](../LICENSE). The
> policies (limits, thresholds, deadlines, approval rules) are examples for a
> fictional company, Acme. Review them with your finance, legal, security or
> HR owners before use. Nothing here is certified for your jurisdiction, and
> no workflow has been run against a live AWS account by this project.

## 1. Choose a workflow

Browse the [workflow catalog](WORKFLOWS.md). It lists 51 workflows by
department, including Finance, People, IT and Security, Legal and Privacy,
RevOps, Supply Chain, Support and Customer Experience.

Each workflow is one TypeScript file in
[`acme-ops/src/workflows/`](../acme-ops/src/workflows), with:

- a business guide in [`docs/workflows/`](workflows);
- local tests in [`acme-ops/test/`](../acme-ops/test);
- an executable verification contract in
  [`acme-ops/verify/contracts/`](../acme-ops/verify/contracts);
- a saved FetchSandbox receipt in
  [`acme-ops/verify/receipts/`](../acme-ops/verify/receipts).

## 2. Read its guide

Each guide in [`docs/workflows/`](workflows) covers:

| Section | What it tells you |
|---|---|
| Business need | The problem and who owns it |
| Trigger and result | An example `start` request, and what the run produces |
| Input contract | Every input field, required or not, with allowed values |
| Agents and responsibilities | What is read, from which provider, in parallel |
| Policies, writes and approval boundaries | Every write the workflow can make, and whether it needs approval |
| Providers, credentials and operations | Environment variables, what must exist in the provider accounts first, human decisions (signals), timers and the audit trail |
| FetchSandbox verification | The contract's checks and the last recorded receipt |

Then read the workflow file itself. Its header comment states the business
rules. Workflows with a **Configurable policy** section in their guide keep
every number, deadline, routing rule and folder layout in
[`acme-ops/policies/<workflow>.json`](../acme-ops/policies); older ones keep
them in a `POLICY` object in the workflow file.

## 3. Prepare provider accounts

Use sandbox or test accounts first: Stripe test mode, a HubSpot developer
portal, a Zendesk sandbox, Plaid sandbox, and so on.

1. Copy [`acme-ops/.env.example`](../acme-ops/.env.example) to
   `acme-ops/.env` and set only the providers your workflow's guide lists.
   Never commit `.env`.
2. Do the "Set up in the provider accounts first" items from the guide, for
   example custom HubSpot properties, Stripe metadata conventions or Notion
   database columns.
3. Give each token the narrowest scope the workflow needs. A provider you
   don't configure is reported as *not configured*. Its agents and actions are
   skipped, never faked.

Each client follows the vendor's published API and pins the vendor's API
version where one exists (Stripe, Shopify, GitHub, Notion, Gusto, Square). See
[PROVIDER_SPEC_AUDIT.md](PROVIDER_SPEC_AUDIT.md) for how the clients were
checked, and for the calls not yet confirmed against the docs.

## 4. Run it locally

```bash
cd acme-ops
npm ci
npm run check && npm test       # type-check and the full local test suite (no network)
npm run bundle
WORKFLOW=dsar-export STATE_FILE=.state/dsar-export.json node --env-file=.env dist/main.mjs
```

The runtime speaks the AgentCore HTTP contract on `:8080`:
`POST /invocations` and `GET /ping`. Try it:

```bash
# What the workflow needs and can do
curl -s localhost:8080/invocations -d '{"action":"describe"}'

# Start a run. runId is your idempotency key: use the triggering event's id.
curl -s localhost:8080/invocations -d '{"action":"start","runId":"dsar-42","input":{...},"requestedBy":{"userId":"U_ME"}}'

# Read it: phase, every agent result, every action and its status
curl -s localhost:8080/invocations -d '{"action":"status","runId":"dsar-42"}'
```

| Command | Use it to |
|---|---|
| `describe` | List agents, providers, every action kind and its gate, and the input JSON Schema |
| `start` | Start a run. Repeating a `runId` returns the existing run |
| `status` | Read the run view |
| `decide` | Approve or reject a run's gated (`approval`) actions: `{"runId","decision":"approve","userId"}` |
| `signal` | Answer one waiting step: `{"runId","actionId","value":"approve"\|"reject","userId","note"?}` |
| `tick` | Fire due timers (reminders, deadlines, follow-ups) across all runs |
| `cancel` | Stop a run that hasn't finished |
| `resume` | Continue a stalled run from its last checkpoint |
| `reconcile` | Re-read every applied effect from its provider and report drift |
| `evidence` | Return the hash-chained audit trail and whether it verifies |

Workflows with reminders or deadlines need `tick`. Locally, set
`TICK_INTERVAL_MS=60000`; a deployed stack schedules it for you.

## 5. Adapt it to your company

- **Policy.** For workflows with a policy file, change
  `acme-ops/policies/<workflow>.json`, or override it per deployment with
  `POLICY_FILE` or `POLICY_JSON` without touching code. The runtime validates
  the policy at startup and refuses an invalid one; each run keeps the policy
  version it started under. See [policies/README.md](../acme-ops/policies/README.md).
  For older workflows, change the `POLICY` constants in the workflow file.
  Either way, policies are versioned and reviewed like code.
- **People.** Approvers, reviewers and channels are inputs, not code. Name
  your own.
- **Tests.** Update `acme-ops/test/<workflow>.test.ts` to match your policy,
  then run `npm test`. The tests use a local fake of each provider
  ([`test/fake-world.ts`](../acme-ops/test/fake-world.ts)) that follows the
  vendors' documented behaviour.
- **Keep the safety properties.** Segregation of duties, write-time
  re-checks, idempotency keys, fail-closed reads and "draft, don't send" are
  what make these workflows safe to run unattended. If you remove one, say so
  in your review.

## 6. Wire its trigger

Each guide names the trigger: a webhook, a schedule, or a request from a
person or system. Send it to `POST /invocations` with `action: "start"`.

- Use the event's own id in `runId` (for example `zd-<ticket>-request` or
  `evt_...`). Re-delivered events then return the same run instead of
  starting a second one.
- Approvals and signals usually come from a chat or ticketing integration you
  own. It calls `decide` or `signal` with the person's user id, and the
  runtime enforces who may answer.

## 7. Deploy

The same container runs on AWS Bedrock AgentCore, Google Cloud Run, Snowflake
Snowpark Container Services or any container host.
[acme-ops/deploy/README.md](../acme-ops/deploy/README.md) compares where state,
secrets, policy and timers live on each, with templates for Cloud Run and
SPCS. The AWS path is below.

### AWS (Bedrock AgentCore)

```bash
cd acme-ops
npx cdk deploy AcmeOps-dsar-export -c approvers:dsar-export=U_PRIVACY_LEAD
# A workflow with a policy file can take a validated override:
npx cdk deploy AcmeOps-<workflow> -c policyFile:<workflow>=./my-policy.json
```

Each workflow is its own stack, `AcmeOps-<workflow>`, and creates:

- an ARM64 AgentCore runtime;
- a DynamoDB table for durable run state;
- a Secrets Manager secret for provider keys;
- X-Ray tracing;
- an EventBridge Scheduler `tick` for workflows that declare timers.

Put the variables from the guide into the stack's secret. See the
[acme-ops README](../acme-ops/README.md#deploy-one-agentcore-runtime-per-workflow)
for IAM and JWT options.

## 8. Verify before you rely on it

- **Local:** `npm run check && npm test` must pass after every change.
- **Provider twins:** with [FetchSandbox](https://fetchsandbox.com/mcp)
  authenticated,
  `node verify/relay-proof.mjs <workflow>` runs the real runtime against
  isolated provider twins and writes a receipt. Read
  [VERIFICATION.md](VERIFICATION.md) first. A checked-in receipt is
  historical evidence for its recorded version, not proof of your change.
- **What twins can't prove yet:** [FETCHSANDBOX_GAPS.md](FETCHSANDBOX_GAPS.md)
  lists, per workflow, which checks are unproven and why. Common reasons: no
  twin for a provider (NetSuite, Gusto, EasyPost), an operation the twin
  doesn't simulate, or the clock-driven steps. Test those paths in your
  provider's sandbox before production.
- **Then** run it against your own sandbox accounts, with real approvers, on
  real data you're allowed to use.

## 9. Operate it

- Watch `status` (or your control plane) for parked approvals and waiting
  signals.
- Run `reconcile` after incidents, or on a schedule, to catch changes made
  outside the workflow.
- Export `evidence` for audits; the hash chain shows the trail is unedited.
- Logs are structured JSON (CloudWatch Logs Insights can filter any field).
  `provider spec deviation` warnings mean a provider answered outside its
  documented API.

## Build your own workflow

Start from [WORKFLOW_TEMPLATE.md](WORKFLOW_TEMPLATE.md) and the kit in
[`acme-ops/src/kit/`](../acme-ops/src/kit):

- Agents read in parallel; actions write, each with a gate.
- Waits use `waitUntil` and `delayAfter`.
- Human decisions use `awaitSignal`, with `from`, `notFrom`, `distinctFrom`
  and a deadline.
- Ordering uses `after` and `requires`.
- Compensation uses `compensate` with `onFailure: "compensate"`.
- Long reads use `checkpoint`; audit trails use `audit: true`.

[CONTRIBUTING.md](../CONTRIBUTING.md) explains how to propose a workflow.
