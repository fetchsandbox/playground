# Workflow catalog

Start with a business need, then read the workflow guide before running it. [ADOPTING.md](ADOPTING.md) walks through connecting your providers, running, adapting, deploying and verifying any workflow below.
This catalog describes repository availability, not the number of runtimes in a private AWS account.
The repository is public and MIT-licensed; your own provider accounts, credentials and deployment are required.

## Availability and proof are separate

Audited on **October 27, 2026**, against repository revision `0da1ca6`.
There are **51 Acme workflow definitions with 152 declared logical roles** in
`acme-ops`. These are not 152 independent models, deployed AWS runtimes or proof
that every workflow passes. Customer Operations is a separate package below.

- **Business behavior and historical receipts:** the individual guides below.
- **Original failure evidence:** [FetchSandbox gap report](FETCHSANDBOX_GAPS.md),
  measured October 22; retain its failures and unmeasured checks.
- **Current fix status, priorities, acceptance and estimated timeline:**
  [FetchSandbox fix and proof plan](FETCHSANDBOX_FIX_PLAN.md).
- **Builder history:** [tracker](TRACKER.md); dated counts are historical cohorts.

As of this audit, no complete R1–R26 requirement has closure evidence. R3 has a
passing 250-customer workflow rerun, with search and bulk-fixture acceptance still
open; R26 has a deployed page-identity fix without the original workflow rerun.
Missing or unmeasured proof is not evidence that an operation is still unsupported
in the current release. Rediscover and remeasure before relying on an old blocker.
The catalog does not establish production deployment or live OAuth/email delivery.

## Acme workflows on main

Progress, twin research and pending work are tracked in [TRACKER.md](TRACKER.md); the plan for the next workflows is [ENTERPRISE_WORKFLOW_PROGRAM.md](ENTERPRISE_WORKFLOW_PROGRAM.md) and FetchSandbox gaps are in [FETCHSANDBOX_GAPS.md](FETCHSANDBOX_GAPS.md).

Each guide includes a business need, department/team, agent roles, input, writes, approval gates, setup, declared scenarios and the exact historical receipt status.

The rightmost column links the **latest known saved receipt**, independently read
back on October 27, 2026. Dates are **Pacific time**; counts describe that run's
checks, not a fresh test of current main or a production certification. Selection
uses the latest snapshot date among committed and additionally recorded evidence,
not an exhaustive search of every account's runs. See the
[receipt audit index](evidence/workflow-catalog-receipts.json) for app-declared
versions, original machine statuses, timestamps and HTTP read-back results.

All 51 main-table workflows have accessible receipts: **8 verified within their
recorded scope, 23 with failed checks, and 20 with checks that could not all be
verified**. Failed and not-checked cases remain visible below. The sweep's newer
receipt supplements its original failed receipt; historical files are unchanged.
A missing receipt requires the workflow's own build and verification path before
adding a result; a local build or a different workflow's receipt is not a substitute.


| S.no | Workflow | Department / team | Roles | Business guide | Latest known FetchSandbox run |
|---:|---|---|---:|---|---|
| 1 | Account takeover containment | IT / `it-security` | 3 | [account-takeover-containment](workflows/account-takeover-containment.md) | [2026-10-21 · 20 passed, 2 not checked](https://fetchsandbox.com/runs/0af7cb3e63?flow=vr_2e81298bdd5645a38f14efcf2db1dcf0) |
| 2 | AI support triage (LLM, guarded) | Support / `support-ops` | 3 | [ai-support-triage](workflows/ai-support-triage.md) | [2026-10-22 · 18 passed, 3 failed](https://fetchsandbox.com/runs/8b707a425c?flow=vr_7609225e94cb4126a1649d0772bd8bb1) |
| 3 | User access review (SOC 2) | IT Security / `grc` | 3 | [user-access-review](workflows/user-access-review.md) | [2026-10-22 · 8 passed, 4 failed](https://fetchsandbox.com/runs/192682caf9?flow=vr_c14cb6f1efe04a0fbf095e93e9089086) |
| 4 | Joiner, mover, leaver access | IT / `it-identity` | 2 | [access-jml](workflows/access-jml.md) | [2026-10-17 · 16 passed, 2 not checked](https://fetchsandbox.com/runs/84e946ba3d?flow=vr_8d2160fd4bd847979c0d3ead96024d41) |
| 5 | Change management gate | Engineering / `platform-ops` | 3 | [change-management-gate](workflows/change-management-gate.md) | [2026-10-22 · 5 passed, 5 failed, 1 not checked](https://fetchsandbox.com/runs/3de250868c?flow=vr_55bd8d33c1bb4538a9936780cce0d10a) |
| 6 | Churn-risk sweep | Customer Success / `cs-ops` | 6 | [churn-risk-sweep](workflows/churn-risk-sweep.md) | [2026-10-16 · 13 passed, 1 not checked](https://fetchsandbox.com/runs/4c1386197c?flow=vr_4750363d6121468999f2717ee7fa0956) |
| 7 | Collections and credit hold | Finance / `ar-collections` | 2 | [collections-credit-hold](workflows/collections-credit-hold.md) | [2026-10-17 · 13 passed](https://fetchsandbox.com/runs/05add583db?flow=vr_1fa37c3665834dee8d573aa5ab82349e) |
| 8 | Compliance documents on request | Quality / `quality-compliance` | 4 | [compliance-docs](workflows/compliance-docs.md) | [2026-10-17 · 9 passed, 2 not checked](https://fetchsandbox.com/runs/793bb8daac?flow=vr_89a3a67d17bd49e393bbd879dacefcce) |
| 9 | Contract intake and signature | Legal / `commercial-legal` | 2 | [contract-intake](workflows/contract-intake.md) | [2026-10-22 · 2 passed, 8 not checked](https://fetchsandbox.com/runs/b935d80696?flow=vr_1485871a757a4168acda54a07e32ae15) |
| 10 | Data subject access request export | Legal / `privacy-ops` | 2 | [dsar-export](workflows/dsar-export.md) | [2026-10-22 · 3 passed, 2 failed, 3 not checked](https://fetchsandbox.com/runs/d18e6b7bda?flow=vr_898103f011f8472f969dde72d7c22bd1) |
| 11 | Consent change propagation | Marketing / `marketing-ops` | 2 | [consent-propagation](workflows/consent-propagation.md) | [2026-10-22 · 4 passed, 4 failed, 1 not checked](https://fetchsandbox.com/runs/6d12a62768?flow=vr_d6428dde89434b3096ac24e1ffe115a0) |
| 12 | CRM ↔ billing sync | RevOps / `revops-systems` | 2 | [crm-billing-sync](workflows/crm-billing-sync.md) | [2026-10-22 · 4 passed, 5 failed](https://fetchsandbox.com/runs/0a57cecd9c?flow=vr_2c28915cdd3446b8ade9092aff67beae) |
| 13 | Purchase request to purchase order | Finance / `procurement` | 2 | [purchase-request-to-po](workflows/purchase-request-to-po.md) | [2026-10-22 · 2 passed, 4 failed, 4 not checked](https://fetchsandbox.com/runs/f872e53438?flow=vr_a1f6960b9f7947978738aa94c733d7ba) |
| 14 | Support first-response SLA | Support / `support-ops` | 3 | [support-sla-breach](workflows/support-sla-breach.md) | [2026-10-22 · 3 passed, 3 failed, 4 not checked](https://fetchsandbox.com/runs/1b1c2cef6e?flow=vr_c92fbe845ccd407b86ac81b3bd23c5da) |
| 15 | Treasury payment approval (dual control) | Finance / `treasury` | 3 | [treasury-payment-approval](workflows/treasury-payment-approval.md) | [2026-10-22 · 2 passed, 4 failed, 4 not checked](https://fetchsandbox.com/runs/b1a7f4f2c1?flow=vr_61dc098b5ebb4006b791152e25b33996) |
| 16 | Usage true-up (committed use) | RevOps / `billing-ops` | 3 | [usage-true-up](workflows/usage-true-up.md) | [2026-10-22 · 5 passed, 4 failed, 1 not checked](https://fetchsandbox.com/runs/aa5bb1a765?flow=vr_dcbd9eb9423c41f18d954ee4153c447a) |
| 17 | Partner sanctions re-screen | Compliance / `financial-crimes` | 3 | [customer-kyc-rescreen](workflows/customer-kyc-rescreen.md) | [2026-10-22 · 2 passed, 2 failed, 4 not checked](https://fetchsandbox.com/runs/6c0ea91459?flow=vr_d94bf68353e54d558e1c472599f41006) |
| 18 | Inventory replenishment | Operations / `supply-chain` | 3 | [inventory-replenishment](workflows/inventory-replenishment.md) | [2026-10-22 · 3 passed, 6 failed](https://fetchsandbox.com/runs/a456cd9e4c?flow=vr_35867ebfc10b434e938b5117c9d12c39) |
| 19 | Delivery exception handling | Operations / `fulfillment-ops` | 3 | [delivery-exception](workflows/delivery-exception.md) | [2026-10-22 · 4 passed, 5 failed](https://fetchsandbox.com/runs/2750a6afec?flow=vr_59e842134e84480d8beaa68bd37fe374) |
| 20 | Payroll anomaly review | People / `payroll-ops` | 3 | [payroll-anomaly-review](workflows/payroll-anomaly-review.md) | [2026-10-22 · 3 passed, 4 failed, 1 not checked](https://fetchsandbox.com/runs/460b43d7b8?flow=vr_42e0d5627b754acda8a2603350d1d9bc) |
| 21 | Work authorization and leave dates | People / `hr-compliance` | 3 | [visa-and-leave-expiry](workflows/visa-and-leave-expiry.md) | [2026-10-22 · 2 passed, 6 failed, 1 not checked](https://fetchsandbox.com/runs/83716cae3a?flow=vr_a609579128f94a92a22d0ea14b5ca3fd) |
| 22 | Cross-border refund (multi-currency) | Customer Experience / `global-support` | 3 | [cross-border-refund](workflows/cross-border-refund.md) | [2026-10-21 · 26 passed, 4 not checked](https://fetchsandbox.com/runs/1f4adfc8be?flow=vr_99c5689f49494f759adad1f473cc1875) |
| 23 | Customer data-quality sweep (at scale) | RevOps / `revops-data` | 2 | [customer-data-sweep](workflows/customer-data-sweep.md) | [2026-10-26 · 8 passed](https://fetchsandbox.com/runs/0978965681?flow=vr_e3c8446a1e2b43628bd85ab307355788) |
| 24 | Distributor rebate and point-of-sale claims | Finance / `channel-finance` | 3 | [distributor-claims](workflows/distributor-claims.md) | [2026-10-17 · 12 passed, 1 not checked](https://fetchsandbox.com/runs/229b5a3ee6?flow=vr_7df15a9babc7455c852404002f0c1f29) |
| 25 | Duplicate charge remediation | Finance / `billing-ops` | 4 | [duplicate-charge-remediation](workflows/duplicate-charge-remediation.md) | [2026-10-19 · 23 passed](https://fetchsandbox.com/runs/942df07202?flow=vr_32045f5c19c54d8fa57cc7504523a437) |
| 26 | Failed-payment dunning | Finance / `billing-ops` | 2 | [failed-payment-dunning](workflows/failed-payment-dunning.md) | [2026-10-22 · 5 passed, 3 failed, 2 not checked](https://fetchsandbox.com/runs/198897286c?flow=vr_243352f82fcf4575922b792da8a81865) |
| 27 | Employee offboarding with final pay | People Operations / `people-ops` | 3 | [employee-offboarding](workflows/employee-offboarding.md) | [2026-10-22 · 5 passed, 5 failed](https://fetchsandbox.com/runs/6721b4e193?flow=vr_e0eba42018b34a0abbcc31f78a52085b) |
| 28 | Export screening and order hold | Trade Compliance / `trade-compliance` | 3 | [export-screening](workflows/export-screening.md) | [2026-10-17 · 13 passed, 1 not checked](https://fetchsandbox.com/runs/ae8c32ab75?flow=vr_0630f2bf77114f0faaed8f22ece14c8a) |
| 29 | Field service dispatch | Service / `field-service` | 4 | [field-service-dispatch](workflows/field-service-dispatch.md) | [2026-10-17 · 14 passed, 2 not checked](https://fetchsandbox.com/runs/11328921ab?flow=vr_6fa5507329d94f57a25f1dcdd6f271b8) |
| 30 | Incident communications | IT / `it-operations` | 2 | [incident-comms](workflows/incident-comms.md) | [2026-10-17 · 14 passed, 3 not checked](https://fetchsandbox.com/runs/dca8a1db6f?flow=vr_76c83c422ebc495b89d551339b6b736c) |
| 31 | Invoice three-way match | Finance / `accounts-payable` | 1 | [invoice-three-way-match](workflows/invoice-three-way-match.md) | [2026-10-22 · 4 passed, 5 failed, 1 not checked](https://fetchsandbox.com/runs/cec6cff8bf?flow=vr_fbd12df7d3c54163a3711aaf0af39176) |
| 32 | Lead routing with first-touch SLA | Sales / `revops` | 3 | [lead-routing-sla](workflows/lead-routing-sla.md) | [2026-10-22 · 7 passed, 2 failed](https://fetchsandbox.com/runs/7657f560d2?flow=vr_ec298074bb2e40a9906d9d41a2a32090) |
| 33 | SaaS license reclaim | IT / `it-asset-mgmt` | 1 | [license-reclaim](workflows/license-reclaim.md) | [2026-10-17 · 14 passed, 1 not checked](https://fetchsandbox.com/runs/d9d39ca07c?flow=vr_b6cd213a86a14632978339bb9525293e) |
| 34 | Month-end close | Finance / `controllership` | 4 | [month-end-close](workflows/month-end-close.md) | [2026-10-22 · 4 passed, 3 failed, 3 not checked](https://fetchsandbox.com/runs/bf7aec0d1d?flow=vr_f88da1c718664c50bd389823c70535ac) |
| 35 | Onboarding kickoff | Sales / `sales-ops` | 5 | [onboarding-kickoff](workflows/onboarding-kickoff.md) | [2026-10-16 · 14 passed, 1 not checked](https://fetchsandbox.com/runs/f4c3a36343?flow=vr_34dd8797cc094b728307d526149991eb) |
| 36 | Order status and expedite | Customer Experience / `cx-service` | 4 | [order-status](workflows/order-status.md) | [2026-10-17 · 14 passed, 2 not checked](https://fetchsandbox.com/runs/bff7380427?flow=vr_be5a26e56b3848efb4526afebc5392a5) |
| 37 | Order to cash with shipping | Operations / `fulfillment-ops` | 3 | [order-to-cash](workflows/order-to-cash.md) | [2026-10-22 · 3 passed, 8 failed](https://fetchsandbox.com/runs/e62545113b?flow=vr_cfd2d89105c2494eafa5054ce7cd773a) |
| 38 | Paid order provisioning (Stripe events) | Sales / `order-ops` | 3 | [paid-order-provisioning](workflows/paid-order-provisioning.md) | [2026-10-21 · 21 passed](https://fetchsandbox.com/runs/7191c10d9e?flow=vr_91d0dcb6472e4337981361327717d67e) |
| 39 | Partner payout run | Finance / `partner-ops` | 3 | [partner-payout-run](workflows/partner-payout-run.md) | [2026-10-21 · 15 passed, 2 not checked](https://fetchsandbox.com/runs/15f2349205?flow=vr_5c1e5f95f6124277a0a7de409adb8344) |
| 40 | Product change and end-of-life notices | Engineering / `product-engineering` | 3 | [pcn-eol-notice](workflows/pcn-eol-notice.md) | [2026-10-17 · 13 passed](https://fetchsandbox.com/runs/f58e5f23dc?flow=vr_851466eb937c45e282a501a9e2697d6c) |
| 41 | Privacy erasure request (GDPR / CCPA) | Legal / `privacy-ops` | 4 | [privacy-erasure](workflows/privacy-erasure.md) | [2026-10-19 · 19 passed](https://fetchsandbox.com/runs/93969092e3?flow=vr_1fae88cbe29d455aa062b167be9977ed) |
| 42 | Product cancellation and refund | Customer Experience / `cx-retention` | 4 | [product-cancellation](workflows/product-cancellation.md) | [2026-10-19 · 27 passed](https://fetchsandbox.com/runs/7c141ce40b?flow=vr_1a9b707387024c149ff1ef377b55630a) |
| 43 | Returns and warranty (RMA) | Customer Experience / `cx-service` | 4 | [returns-warranty](workflows/returns-warranty.md) | [2026-10-17 · 14 passed, 3 not checked](https://fetchsandbox.com/runs/d196fed8ac?flow=vr_e0778cfd16fd4a1db57cf35861be60d9) |
| 44 | Revenue reconciliation | Finance / `revops-finance` | 3 | [revenue-reconciliation](workflows/revenue-reconciliation.md) | [2026-10-16 · 12 passed, 1 not checked](https://fetchsandbox.com/runs/a630507692?flow=vr_deac92d8f5264a81bdfe6a17d17192ca) |
| 45 | RFQ to quote | Sales / `sales-ops` | 4 | [rfq-quote](workflows/rfq-quote.md) | [2026-10-17 · 14 passed, 2 not checked](https://fetchsandbox.com/runs/451bef1458?flow=vr_9d553a7d44fe4af4b760c3f63e937ffb) |
| 46 | Security questionnaire responder | IT / `it-security` | 3 | [security-questionnaire](workflows/security-questionnaire.md) | [2026-10-17 · 11 passed, 1 not checked](https://fetchsandbox.com/runs/ecc2c079f7?flow=vr_e1ca4d13d678473b9992cd1751db6cdf) |
| 47 | Service and monitoring renewals | Customer Success / `cs-ops` | 3 | [service-renewals](workflows/service-renewals.md) | [2026-10-17 · 13 passed](https://fetchsandbox.com/runs/335177d131?flow=vr_aa323bfd73a1418aad16a46b2a53675e) |
| 48 | Supplier nonconformance and corrective action | Quality / `supplier-quality` | 3 | [supplier-ncr](workflows/supplier-ncr.md) | [2026-10-17 · 13 passed, 1 not checked](https://fetchsandbox.com/runs/6479cad67b?flow=vr_cab530b56d13455182166ea403619f61) |
| 49 | Supplier bank-detail change (fraud control) | Finance / `accounts-payable` | 4 | [supplier-bank-change](workflows/supplier-bank-change.md) | [2026-10-22 · 4 passed, 5 failed, 4 not checked](https://fetchsandbox.com/runs/855eccad90?flow=vr_1d352154f9af49b5b8738b1d015ff7e8) |
| 50 | Vulnerability remediation SLA | IT Security / `appsec` | 1 | [vulnerability-remediation](workflows/vulnerability-remediation.md) | [2026-10-22 · 3 passed, 3 failed, 3 not checked](https://fetchsandbox.com/runs/5825e3a8cf?flow=vr_14858015802a4bd8bc7aff4532274dff) |
| 51 | Support escalation | Support / `support-ops` | 5 | [support-escalation](workflows/support-escalation.md) | [2026-10-16 · 15 passed, 1 not checked](https://fetchsandbox.com/runs/a3e6951d42?flow=vr_560dd52d3f244aaba40f6d925ae8c5c7) |

[Customer Operations](workflows/customer-operations.md) is also on `main`: six specialist roles plus an approval-controlled dispatch stage. Its own FetchSandbox runner/receipt is not present on `main`.

## Separate branch examples

These guides describe code outside `main`; follow the source branch/PR and its setup instructions. Links do not imply a merged or verified release.

| Example | Owning department/team | Roles | Guide |
|---|---|---:|---|
| Original quote agent | Revenue Operations / Sales Support and Quote Operations | 1 | [Quote agent](workflows/quote-agent.md) |
| Customer handoff | Customer Onboarding Operations / Customer Onboarding and Billing Operations | 5 | [Handoff](workflows/customer-handoff.md) |
| Refund eligibility and resolution | Customer Service and Revenue Operations / Refund Assurance | 6 | [Refund operations](workflows/refund-operations.md) |

[PR #68](https://github.com/fetchsandbox/playground/pull/68) merged on October 19, 2026. Duplicate-charge remediation and privacy-erasure are included in the main catalog above. Merge status does not establish deployment or a fresh verification result.

## Small integration apps and planted-bug exercises

These are separate from the enterprise workflow catalog. Read their own setup and findings; do not infer a blanket verification result.

- [Commerce SDK shopper-message recovery](../opencommerce-recovery/README.md): local
  deliberate-failure reference using the published Agentcard SDK, PostgreSQL and
  a captured-message sink. No live purchases or provider API calls. See its
  [measured evidence](../opencommerce-recovery/evidence/RESULTS.md) for the exact
  contract, source version and remaining acceptance limits.

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
