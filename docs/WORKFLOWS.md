# Workflow catalog

Start with a business need, then read the workflow guide before running it.
This catalog describes repository availability, not the number of runtimes in a private AWS account.
The repository is public and MIT-licensed; your own provider accounts, credentials and deployment are required.

## Acme workflows on main

Progress, twin research and pending work are tracked in [TRACKER.md](TRACKER.md); the plan for the next workflows is [ENTERPRISE_WORKFLOW_PROGRAM.md](ENTERPRISE_WORKFLOW_PROGRAM.md) and FetchSandbox gaps are in [FETCHSANDBOX_GAPS.md](FETCHSANDBOX_GAPS.md).

Each guide includes a business need, department/team, agent roles, input, writes, approval gates, setup, declared scenarios and the exact historical receipt status.

| Workflow | Department / team | Roles | Business guide |
|---|---|---:|---|
| Account takeover containment | IT / `it-security` | 3 | [account-takeover-containment](workflows/account-takeover-containment.md) |
| AI support triage (LLM, guarded) | Support / `support-ops` | 3 | [ai-support-triage](workflows/ai-support-triage.md) |
| User access review (SOC 2) | IT Security / `grc` | 3 | [user-access-review](workflows/user-access-review.md) |
| Joiner, mover, leaver access | IT / `it-identity` | 2 | [access-jml](workflows/access-jml.md) |
| Change management gate | Engineering / `platform-ops` | 3 | [change-management-gate](workflows/change-management-gate.md) |
| Churn-risk sweep | Customer Success / `cs-ops` | 6 | [churn-risk-sweep](workflows/churn-risk-sweep.md) |
| Collections and credit hold | Finance / `ar-collections` | 2 | [collections-credit-hold](workflows/collections-credit-hold.md) |
| Compliance documents on request | Quality / `quality-compliance` | 4 | [compliance-docs](workflows/compliance-docs.md) |
| Contract intake and signature | Legal / `commercial-legal` | 2 | [contract-intake](workflows/contract-intake.md) |
| Data subject access request export | Legal / `privacy-ops` | 2 | [dsar-export](workflows/dsar-export.md) |
| Consent change propagation | Marketing / `marketing-ops` | 2 | [consent-propagation](workflows/consent-propagation.md) |
| CRM ↔ billing sync | RevOps / `revops-systems` | 2 | [crm-billing-sync](workflows/crm-billing-sync.md) |
| Purchase request to purchase order | Finance / `procurement` | 2 | [purchase-request-to-po](workflows/purchase-request-to-po.md) |
| Support first-response SLA | Support / `support-ops` | 3 | [support-sla-breach](workflows/support-sla-breach.md) |
| Treasury payment approval (dual control) | Finance / `treasury` | 3 | [treasury-payment-approval](workflows/treasury-payment-approval.md) |
| Usage true-up (committed use) | RevOps / `billing-ops` | 3 | [usage-true-up](workflows/usage-true-up.md) |
| Partner sanctions re-screen | Compliance / `financial-crimes` | 3 | [customer-kyc-rescreen](workflows/customer-kyc-rescreen.md) |
| Cross-border refund (multi-currency) | Customer Experience / `global-support` | 3 | [cross-border-refund](workflows/cross-border-refund.md) |
| Customer data-quality sweep (at scale) | RevOps / `revops-data` | 2 | [customer-data-sweep](workflows/customer-data-sweep.md) |
| Distributor rebate and point-of-sale claims | Finance / `channel-finance` | 3 | [distributor-claims](workflows/distributor-claims.md) |
| Duplicate charge remediation | Finance / `billing-ops` | 4 | [duplicate-charge-remediation](workflows/duplicate-charge-remediation.md) |
| Failed-payment dunning | Finance / `billing-ops` | 2 | [failed-payment-dunning](workflows/failed-payment-dunning.md) |
| Employee offboarding with final pay | People Operations / `people-ops` | 3 | [employee-offboarding](workflows/employee-offboarding.md) |
| Export screening and order hold | Trade Compliance / `trade-compliance` | 3 | [export-screening](workflows/export-screening.md) |
| Field service dispatch | Service / `field-service` | 4 | [field-service-dispatch](workflows/field-service-dispatch.md) |
| Incident communications | IT / `it-operations` | 2 | [incident-comms](workflows/incident-comms.md) |
| Invoice three-way match | Finance / `accounts-payable` | 1 | [invoice-three-way-match](workflows/invoice-three-way-match.md) |
| Lead routing with first-touch SLA | Sales / `revops` | 3 | [lead-routing-sla](workflows/lead-routing-sla.md) |
| SaaS license reclaim | IT / `it-asset-mgmt` | 1 | [license-reclaim](workflows/license-reclaim.md) |
| Month-end close | Finance / `controllership` | 4 | [month-end-close](workflows/month-end-close.md) |
| Onboarding kickoff | Sales / `sales-ops` | 5 | [onboarding-kickoff](workflows/onboarding-kickoff.md) |
| Order status and expedite | Customer Experience / `cx-service` | 4 | [order-status](workflows/order-status.md) |
| Order to cash with shipping | Operations / `fulfillment-ops` | 3 | [order-to-cash](workflows/order-to-cash.md) |
| Paid order provisioning (Stripe events) | Sales / `order-ops` | 3 | [paid-order-provisioning](workflows/paid-order-provisioning.md) |
| Partner payout run | Finance / `partner-ops` | 3 | [partner-payout-run](workflows/partner-payout-run.md) |
| Product change and end-of-life notices | Engineering / `product-engineering` | 3 | [pcn-eol-notice](workflows/pcn-eol-notice.md) |
| Privacy erasure request (GDPR / CCPA) | Legal / `privacy-ops` | 4 | [privacy-erasure](workflows/privacy-erasure.md) |
| Product cancellation and refund | Customer Experience / `cx-retention` | 4 | [product-cancellation](workflows/product-cancellation.md) |
| Returns and warranty (RMA) | Customer Experience / `cx-service` | 4 | [returns-warranty](workflows/returns-warranty.md) |
| Revenue reconciliation | Finance / `revops-finance` | 3 | [revenue-reconciliation](workflows/revenue-reconciliation.md) |
| RFQ to quote | Sales / `sales-ops` | 4 | [rfq-quote](workflows/rfq-quote.md) |
| Security questionnaire responder | IT / `it-security` | 3 | [security-questionnaire](workflows/security-questionnaire.md) |
| Service and monitoring renewals | Customer Success / `cs-ops` | 3 | [service-renewals](workflows/service-renewals.md) |
| Supplier nonconformance and corrective action | Quality / `supplier-quality` | 3 | [supplier-ncr](workflows/supplier-ncr.md) |
| Supplier bank-detail change (fraud control) | Finance / `accounts-payable` | 4 | [supplier-bank-change](workflows/supplier-bank-change.md) |
| Vulnerability remediation SLA | IT Security / `appsec` | 1 | [vulnerability-remediation](workflows/vulnerability-remediation.md) |
| Support escalation | Support / `support-ops` | 5 | [support-escalation](workflows/support-escalation.md) |

[Customer Operations](workflows/customer-operations.md) is also on `main`: six specialist roles plus an approval-controlled dispatch stage. Its own FetchSandbox runner/receipt is not present on `main`.

## Separate branch examples

These guides describe code outside `main`; follow the source branch/PR and its setup instructions. Links do not imply a merged or verified release.

| Example | Owning department/team | Roles | Guide |
|---|---|---:|---|
| Original quote agent | Revenue Operations / Sales Support and Quote Operations | 1 | [Quote agent](workflows/quote-agent.md) |
| Customer handoff | Customer Onboarding Operations / Customer Onboarding and Billing Operations | 5 | [Handoff](workflows/customer-handoff.md) |
| Refund eligibility and resolution | Customer Service and Revenue Operations / Refund Assurance | 6 | [Refund operations](workflows/refund-operations.md) |

[PR #68](https://github.com/fetchsandbox/playground/pull/68) proposes duplicate-charge remediation and privacy-erasure workflows. They are not included as merged or deployed examples here.

## Small integration apps and planted-bug exercises

These are separate from the enterprise workflow catalog. Read their own setup and findings; do not infer a blanket verification result.

- [agentmail](../apps/agentmail/README.md)
- [clerk](../apps/clerk/README.md)
- [descope](../apps/descope/README.md)
- [descope-onboarding](../apps/descope-onboarding/README.md)
- [hubspot](../apps/hubspot/README.md)
- [paddle/01-subscriptions](../apps/paddle/01-subscriptions/README.md)
- [paddle/02-billing](../apps/paddle/02-billing/README.md)
- [paddle/03-entitlements](../apps/paddle/03-entitlements/README.md)
- [paddle/04-upgrades](../apps/paddle/04-upgrades/README.md)
- [paddle/05-trials](../apps/paddle/05-trials/README.md)
- [paddle/06-pause-resume](../apps/paddle/06-pause-resume/README.md)
- [paddle/07-dunning](../apps/paddle/07-dunning/README.md)
- [paddle/08-checkout](../apps/paddle/08-checkout/README.md)
- [paddle/09-seats](../apps/paddle/09-seats/README.md)
- [paddle/10-refunds](../apps/paddle/10-refunds/README.md)
- [resend](../apps/resend/README.md)
- [stripe](../apps/stripe/README.md)
- [stripe-receipts](../apps/stripe-receipts/README.md)
- [surge](../apps/surge/README.md)

[Invoice Watch](../invoice-watch/README.md) is a BDK-based project with its own agent instructions and eval loop.

## Contribution and verification

Read [AGENTS.md](../AGENTS.md), [verification](VERIFICATION.md) and the [new-workflow template](WORKFLOW_TEMPLATE.md). Coding-agent guidance makes FetchSandbox the default for integration changes; a receipt is still required to establish measured behavior. Historical blockers must be reassessed against current MCP discovery, not silently discarded.
