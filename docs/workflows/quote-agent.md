# Quote agent: customer quote and discount approval

## Business need and ownership

Sales Support needs to turn a customer request into a priced quote, clarify an
unspecified discount, enforce its discount policy and keep customer/manager
messages attached to that quote. Demo department: **Revenue Operations**. Team:
**Sales Support and Quote Operations**; configure an individual owner.

## Code availability and setup

This example is maintained on the separate
[`quote-agent-workflow` branch](https://github.com/fetchsandbox/playground/tree/quote-agent-workflow),
with [PR #38](https://github.com/fetchsandbox/playground/pull/38). It is not a
folder on `main` at this documentation revision. Follow that branch's README for
its Python dependencies, private environment, runtime deployment and configured
Slack/Gmail adapters. Do not assume those adapters exist in your AWS account.

## Agent, policy and communication

The one quote-agent role classifies requests and coordinates catalog/quote,
HubSpot and messaging tools. The demo policy distinguishes a discount below 20%,
20%–70% needing approval and above 70% being declined. A discount without a valid
percentage needs clarification. Confirm the branch's actual policy before reuse;
this is different from `acme-ops/rfq-quote`.

Slack/email intake, approval routing and sender identities are deployment
configuration. The customer receives only the outcome actually sent; a manager
notification or draft is not customer delivery. Use a dedicated business inbox or
explicit allowed recipient rather than processing a personal Inbox broadly.

## FetchSandbox proof and limits

Follow [the verification loop](../VERIFICATION.md). Cover quote totals, missing
percentage, policy boundaries, requester/approver identity, approved/rejected
continuation, duplicate events, failed sends and saved CRM/customer outcomes.
Obtain a fresh receipt for your branch/contract. There is no checked-in `main`
receipt here that certifies your deployment. The deployed demo's session-local
SQLite also requires an explicit durability/restart assessment; do not describe
it as durable merely because it runs in AgentCore.
