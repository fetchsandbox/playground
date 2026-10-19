# Customer Operations: coordinated account request

## Business need

A customer request can involve pricing, billing questions, account research and
follow-up. Customer Operations needs one accountable handoff that includes
partial failures, followed by approval before outward dispatch.

Demo department: **Customer Operations**. Team: **Customer Success and Billing
Operations**. Configure the individual owner and approvers for your deployment.

## Agents, tools and handoff

| Role | Responsibility | Provider boundary |
|---|---|---|
| Intake | Classify request, identify customer and select specialist work | HubSpot contact create-or-get |
| Research | Account brief from CRM, recent email threads and search | Read-only provider research |
| Quote | Catalog matching, code-calculated pricing, draft quote/deal | Stripe and HubSpot writes |
| Billing | Billing health and outstanding balance | Read-only; no money movement |
| Survey | Draft feedback request with customer cooldown | Draft preparation |
| Handoff | Combine outputs/failures into owner/customer handoff | HubSpot note |

These are six logical roles. After approval, **dispatch is an execution stage**
that finalizes the quote and sends the approved communication; it is not counted
as an additional specialist agent. A completed draft does not establish delivery.

## Trigger, policy and outcome

The public runtime entry is `POST /invocations` with a `start` command and
`requestText`. Slack/control-plane intake needs its own adapter. The engine parks
for approval after specialist work and handoff; dispatch follows the authorized
decision. Read the source for exact pricing, cooldown and approver configuration.

```json
{
  "action": "start",
  "runId": "demo-customer-ops-001",
  "requestText": "Quote 5 Pro seats for buyer@example.test and check billing.",
  "requestedBy": {"userId": "U_DEMO_REQUESTER"},
  "wait": true
}
```

Use the sample only with isolated fixtures. Do not forward personal mailbox
contents to model/provider services without an appropriate data/access boundary.

## Setup, storage and verification

```bash
cd customer-ops-agents
npm ci
npm run check
npm test
npm run serve:fakes
```

The fake-provider command is a local setup exercise, not FetchSandbox proof or a
live Claude evaluation. Real deployment uses this package's DynamoDB checkpoints,
leases and effect ledger, private provider secrets and configured approvers.
See the [package setup/API/deployment guide](../../customer-ops-agents/README.md).

Follow [the repository verification loop](../VERIFICATION.md). This package on
`main` does **not** contain the Acme `verify/relay-proof.mjs` runner or a package
receipt directory. Do not claim that runner works here. Establish its own contract
against `/invocations`, durable status and provider observations, and record the
exact missing harness or MCP blocker if it cannot run. Local unit tests alone are
not a FetchSandbox acceptance receipt.

Relevant cases: provider isolation, duplicate/concurrent triggers, approval and
unauthorized decision, parked-run restart/resume, customer survey cooldown,
partial dispatch recovery and provider readback. Relevant does not mean measured.

- [Agent implementations](../../customer-ops-agents/src/agents)
- [Engine and approval/dispatch implementation](../../customer-ops-agents/src/workflow)
- [Provider clients](../../customer-ops-agents/src/providers)
- [Deployment infrastructure](../../customer-ops-agents/infra/stack.ts)
