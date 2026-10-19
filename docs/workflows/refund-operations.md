# Refund operations: evidence, policy and customer resolution

## Business need and ownership

Customer Service and Revenue Operations needs to verify the actual purchase,
product conditions and current refund policies before moving money. Team:
**Refund Assurance**; configure the named owner and authorized approvers.

## Code availability and agents

The implementation is on the
[`codex/acme-refund-operations` branch](https://github.com/fetchsandbox/playground/tree/codex/acme-refund-operations)
and [PR #63](https://github.com/fetchsandbox/playground/pull/63), not a folder on
`main` at this revision. Follow that branch's setup, input and deployment guide.
Its six roles are intake, purchase research, product inventory, policy research,
billing policy and customer handoff. They separate evidence gathering from the
authorized financial action and customer communication.

## Policy and triggers

The demo policy uses the requested share of the original payment: **below 20%**
automatic when otherwise eligible; **20%–70%** requires approval; **above 70%** is
declined. Purchase ownership, age, disputes/prior refunds and product-specific
return/usage evidence still apply. A small percentage does not override missing
eligibility evidence. The company/product policies are synthetic demo policies,
not an assertion about any actual merchant's terms.

Slack, email and shop triggers require deployed intake adapters and matching
customer identity. The [demo shop PR](https://github.com/fetchsandbox/playground/pull/64)
is a separate component. The intended financial effect is an original-payment
Stripe test refund, with a customer outcome and linked operator thread. Do not
mistake this for `product-cancellation`, which has a different policy and refund
method selection.

## Setup, proof and production limits

Follow the branch's private credential, versioned-policy storage, test-product,
merchant-evidence and approver setup. Never use live payment keys for a demo run.
Follow [the FetchSandbox loop](../VERIFICATION.md), covering missing evidence,
wrong customer, percentage boundaries, approval/rejection, repeated approval,
provider failure, uncertain response, one refund and one customer notification.
Record actual saved Stripe state and the communication result separately.

No receipt linked from this `main` guide proves your deployment. Link fresh
branch/contract/version-specific evidence when contributing. Test fixtures are
labelled synthetic; simulated inspection is not evidence of a real physical return.
