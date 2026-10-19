# Customer handoff: quote to onboarding, billing and welcome

## Business need and ownership

Customer Onboarding needs a coordinated progression from a quote to the CRM
customer, billing invoice and welcome message. A failed downstream step must be
visible and recoverable instead of appearing as a successful customer handoff.
Demo department: **Customer Onboarding Operations**; team: **Customer Onboarding
and Billing Operations**. Configure the individual owner and operator permissions.

## Code availability, agents and systems

The implementation is on the separate
[`handoff-agents` branch](https://github.com/fetchsandbox/playground/tree/handoff-agents)
and [PR #39](https://github.com/fetchsandbox/playground/pull/39), not a folder on
`main` at this revision. Its five declared roles are:

| Role | Business responsibility |
|---|---|
| Quote | Produce the commercial starting point |
| Research | Gather customer/account context |
| CRM | Establish the HubSpot customer record |
| Billing | Create the Stripe billing artifact |
| Messaging | Send the Resend welcome message after the handoff |

Follow that branch's README and manifests for its actual APIs, input schema,
private HubSpot/Stripe/Resend configuration, state and AgentCore deployment.
Use sandbox accounts and synthetic recipients for reproduction. The separate
operator runtime is a control surface, not a sixth business agent.

## Policy, outcomes and verification

Keep the dependency order, authorization and containment boundaries from the
source. Do not assume a quote approval authorizes unrelated billing or messages.
The desired outcome includes the saved CRM and billing references and measured
welcome-message result. A provider's accepted response is not recipient inbox
proof.

Follow [the verification loop](../VERIFICATION.md). Measure each handoff, failed
provider, duplicate/retry, partial completion, authorized pause/resume and
independent reconciliation. Do not copy an `acme-ops` contract onto this different
API. A new user needs their own scoped contract and fresh evidence; existing AWS
demo deployment does not supply credentials or certify their integration.
