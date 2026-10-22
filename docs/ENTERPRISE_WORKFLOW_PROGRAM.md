# Enterprise operations workflow program

Status (2026-10-22): waves 1–3 (24 workflows) and Kit v2 built; provider clients audited against vendor docs; all 24 re-proven on FetchSandbox with every gap classified. Owner: FetchSandbox (dogfooding). Progress is
tracked in [TRACKER.md](TRACKER.md); FetchSandbox gaps found so far are in
[FETCHSANDBOX_GAPS.md](FETCHSANDBOX_GAPS.md).

## Why this exists

FetchSandbox is meant to prove that an operations workflow built by a team
(or a coding agent) behaves correctly against real provider behaviour before
it touches production. The fastest way to find where the engine falls short
is to build the workflows enterprises actually run, in full, and ask
FetchSandbox to prove them. So the rule for this program is:

- **Choose workflows by business demand, not by which twins exist.** A
  workflow that needs a twin FetchSandbox doesn't have is still built; the
  missing twin becomes a requirement.
- **Build them industry grade:** durable (survive restarts and multi-week
  waits), reliable (idempotent effects, compensation, fail-closed), scalable
  (paged, checkpointed, bounded fan-out), trackable (every decision and
  effect in an audit trail a reviewer or auditor can use).
- **Open source and deployable:** every workflow is an AgentCore runtime
  (`WORKFLOW=<id>`, `POST /invocations`, `GET /ping`) with a CDK stack, a
  business guide, local tests against faithful fakes, and a FetchSandbox
  contract whose checks state business behaviour as executable expectations.
- **Nothing is declared blocked up front.** The receipt says what
  FetchSandbox could measure; everything it couldn't is a gap to build.

## What enterprises are automating (research)

Sources are listed at the end. Across finance, procurement, people, IT,
security, revenue and supply-chain operations the same shape recurs: systems
match and draft, people approve only the exceptions, and every step is
evidence.

| Function | Workflows with the most demand | What makes them hard |
|---|---|---|
| Accounts payable / procure-to-pay | Three-way match (PO, receipt, invoice) with exception routing; payment runs; duplicate-invoice detection | Exceptions differ in risk (rounding vs unknown supplier vs duplicate); agents must not approve their own exception or call a payment API without an independent authorization |
| Supplier management | Supplier onboarding (KYB, tax id, sanctions, bank ownership), **bank-detail changes** | Bank-change fraud: verify through an independent channel, separate setup from payment approval, alert on unexpected changes |
| Record-to-report | Month-end close orchestration: bank and GL reconciliations, intercompany, accruals, journal approvals | Multi-day checklist with deadlines and escalations; propose-and-approve journals with audit trail |
| People operations | Onboarding, **offboarding with final pay**, payroll anomaly review, leave and visa expiry | State-by-state final-pay deadlines (some "immediately"); a termination entered late is the usual violation |
| IT and security | **User access reviews** (SOC 2 / SOX), incident response, vulnerability SLA, change management | Weeks-long campaigns with reviewers, reminders and revocations; evidence that can't be edited after close |
| Revenue operations | Lead routing with SLA, quote-to-contract, usage true-ups, CRM↔billing sync | Ordering and conflict resolution between systems; SLA timers |
| Supply chain | Order-to-cash, replenishment, delivery exceptions, returns | ERP and carrier state, partial shipments, compensation when a later step fails |
| Legal and privacy | Contract intake (NDA triage), DSAR export, consent propagation | LLM-assisted review under a clause playbook; statutory deadlines |
| Support | SLA breach escalation, AI triage | Business-hours timers, model guardrails |

## What is already built (30 runtimes)

| Function | Built |
|---|---|
| Finance | duplicate-charge-remediation, partner-payout-run, collections-credit-hold, revenue-reconciliation, distributor-claims, failed-payment-dunning, cross-border-refund |
| Customer experience / support | product-cancellation, order-status, returns-warranty, support-escalation, ai-support-triage |
| Sales / RevOps / CS | rfq-quote, onboarding-kickoff, paid-order-provisioning, churn-risk-sweep, service-renewals, customer-data-sweep |
| IT / security | access-jml, license-reclaim, incident-comms, security-questionnaire, account-takeover-containment |
| Legal / compliance | privacy-erasure, compliance-docs, export-screening |
| Operations / supply chain | order-to-cash, field-service-dispatch, supplier-ncr, pcn-eol-notice |

## What to build next (not yet built)

Twin status: **Y** a FetchSandbox twin exists and is stateful enough,
**P** a twin exists but the probes found it partial or sample-backed,
**N** no twin (`validate_integration` → "Unknown providers").

### Wave 1: the controls auditors ask about first (built)

All six are built with local tests against faithful fakes and FetchSandbox
contracts; receipts and gaps are tracked in FETCHSANDBOX_GAPS.md.

| Workflow | Business purpose | Providers (twin) | Engine pressure | Kit capability |
|---|---|---|---|---|
| `supplier-bank-change` | Verify a supplier's bank-detail change before any payment uses it: callback to the number on file (not the one in the request), account-ownership check, sanctions re-screen, 2-person approval, payment hold until verified | NetSuite (N), Plaid (P, catalog only), Twilio (P), screening (N), Gmail (Y), Slack (Y) | callbacks that arrive days later, segregation of duties, fraud scenarios | durable wait for callback; per-item decision |
| `user-access-review` | Quarterly SOC 2 access certification: pull entitlements from every app, route each to its owner, remind and escalate, revoke what is rejected, seal tamper-evident evidence | WorkOS (P), GitHub (P), Slack (Y), Google Workspace (N), Okta (N), Asana (P) | weeks-long campaign, thousands of decisions, revocation proof | durable timers, per-item decisions, checkpointed fan-out, hash-chained audit |
| `employee-offboarding` | Termination → final pay by the work state's deadline, access revoked everywhere, equipment return label, benefits notice; late entry escalates | Gusto/Rippling (N), WorkOS (P), GitHub (P), Slack (Y), EasyPost (N), Gmail (Y) | statutory deadlines, partial failure across many systems, compensation | durable timers, saga compensation |
| `invoice-three-way-match` | AP invoice → match PO and receipt, classify exceptions by risk, auto-approve within tolerance, route the rest, queue the payment run | NetSuite (N), Box (P) for invoice PDFs, OpenAI (P) for extraction, Slack (Y) | document extraction, tolerance math, duplicate detection at volume | per-item decisions, checkpointed batches |
| `month-end-close` | Close checklist: Stripe payouts ↔ bank (Plaid) ↔ ledger reconciliations, accrual journals proposed and approved, deadline escalations, close sign-off | Stripe (Y), Plaid (P), NetSuite (N), Asana (P), Slack (Y) | multi-day orchestration, deadlines, many sub-tasks | durable timers, child tasks, audit |
| `change-management-gate` | Production change → freeze-window and on-call checks, risk-based CAB approval, deploy, error-rate watch, automatic rollback | GitHub (P), PagerDuty (P), Datadog (P), Slack (Y) | watch windows, rollback compensation | durable timers, saga compensation |

### Wave 2: revenue, privacy and security operations

| Workflow | Purpose | Providers (twin) | Kit capability |
|---|---|---|---|
| `lead-routing-sla` | Enrich, dedupe, route by territory and capacity, first-touch SLA timer with reassignment | HubSpot (Y), Clearbit (N), Slack (Y) | durable timers |
| `vulnerability-remediation` | Scanner findings → owner tickets → SLA by severity → escalation → risk-acceptance approvals with expiry | GitHub (P), Snyk (N), Jira (N), Slack (Y) | timers, per-item decisions |
| `contract-intake` | NDA/MSA triage against a clause playbook (LLM), redline approval, e-signature, renewal date captured | OpenAI (P), DocuSign (N), Box (P), Salesforce (N) | per-item decisions |
| `dsar-export` | Data-subject access request: verify identity, collect from every system, package, deliver securely in 30 days | HubSpot (Y), Stripe (Y), Zendesk (P), Gmail (Y), Box (P) | durable timers, checkpointed fan-out |
| `consent-propagation` | Unsubscribe / consent change propagated to every system in order, with conflict and replay handling | HubSpot (Y), Resend (P), Stripe (Y), Zendesk (P) | event inbox ordering |
| `crm-billing-sync` | Two-way account sync HubSpot↔Stripe with conflict rules and drift reconciliation | HubSpot (Y), Stripe (Y) | checkpointed batches |
| `purchase-request-to-po` | Intake → budget check → approval matrix by amount and category → PO in ERP → supplier notice | NetSuite (N), Ramp/Coupa (N), Slack (Y) | multi-level approvals |

### Wave 3: supply chain, people and treasury

`inventory-replenishment` (Shopify P, NetSuite N), `delivery-exception`
(EasyPost N, Zendesk P, Stripe Y), `payroll-anomaly-review` (Gusto N),
`usage-true-up` (Stripe meters P, HubSpot Y), `support-sla-breach` (Zendesk P,
PagerDuty P), `treasury-payment-approval` (Plaid P, Modern Treasury N),
`customer-kyc-rescreen` (screening N, Stripe Y), `visa-and-leave-expiry`
(HRIS N, Calendar P).

## Kit v2: what "industry grade" needs from the runtime (built)

Built in `acme-ops/src/kit/engine.ts` as opt-in fields on a planned action,
so existing workflows behave exactly as before (their tests are unchanged):
`waitUntil` and `delayAfter` (durable timers), `awaitSignal` with `from`,
`notFrom`, `distinctFrom`, `deadline` and `onDeadline` (per-item decisions,
two-person rule), `after` and `requires` (ordering and preconditions),
`compensate` with `onFailure: "compensate"` (sagas), `SkipAction` (decided
not to apply), `ctx.checkpoint` (resumable agents), `audit: true` (hash-chained
trail, `evidence` command) and `tickEvery` (EventBridge Scheduler invoking
`{action:"tick"}` on AgentCore; `TICK_INTERVAL_MS` elsewhere). New commands:
`signal`, `tick`, `evidence`. Covered by `acme-ops/test/kit-v2.test.ts`.

Known limit: a run's actions live in one record, so very large campaigns are
capped (500 entitlements per access-review run) until action records move to
their own items.

The current kit gives parallel read-only agents, a pure plan, gated actions
with one approval per run, effect claims (idempotency), restart durability,
resume and reconcile. Wave 1 needs more, added without changing how existing
workflows behave:

| # | Capability | Why | AWS deployment |
|---|---|---|---|
| K1 | **Durable timers**: an action or the run can wait until a time (`waitUntil`) or for a signal with a deadline | access-review reminders, final-pay deadlines, callback windows, watch windows | EventBridge Scheduler calls `resume`; local: a timer table polled by the server |
| K2 | **Signals and per-item decisions**: external input addressed to one action (approve/reject this entitlement, callback confirmed) instead of one decision for the whole run | access reviews, exception queues, multi-approver chains, segregation of duties (approver ≠ requester ≠ setup user) | `POST /invocations {action:"signal"}` |
| K3 | **Compensation (sagas)**: an action declares its undo; when a later required step fails, applied steps are compensated in reverse order and recorded | offboarding, change rollback, order-to-cash | none |
| K4 | **Checkpointed fan-out**: process thousands of items in bounded batches, persisting a cursor so a restart continues where it stopped | access review pulls, sweeps, invoice batches | DynamoDB checkpoint item |
| K5 | **Tamper-evident audit trail**: every decision, signal and effect appended with a hash chain; an evidence export that verifies | SOC 2 / SOX evidence | S3 object lock export |
| K6 | **Observability**: OpenTelemetry spans per agent and action, run metrics (latency, retries, approvals waiting) | operating hundreds of runs | CloudWatch / X-Ray |

Each capability gets its own FetchSandbox checks (restart while waiting on a
timer, a signal for an unknown item, compensation after a mid-saga fault,
crash between batches, evidence verification), which in turn tell us what
the engine must support: time travel for timers, signals in contracts,
multi-step fault placement.

## FetchSandbox requirements this program will exercise

Known now (details and evidence in FETCHSANDBOX_GAPS.md): scripted LLM
completions; Stripe time and failed-collection lifecycle; faithful pagination
and bulk fixtures; ERP (NetSuite), carrier (EasyPost/Shippo), HRIS/payroll
(Gusto/Rippling), e-signature (DocuSign), identity (Okta, Google Workspace
Admin), ITSM (Jira/ServiceNow), screening (Trade.gov CSL) twins; current
Shopify versions; operator input for more provider writes; webhook-to-check
correlation; tunnel allowance. Expected from Kit v2: **clock control** in
contracts (advance a run's time to fire a timer), **signals as contract
steps**, **fault placement at step N of a saga**, **observation of
checkpoints** across a restart.

## How each workflow is delivered

1. Business guide entry (why, owner, policy, approval boundary).
2. Runtime in `acme-ops/src/workflows/<id>.ts`; new provider clients in
   `src/providers/` against the vendor's real API.
3. Local tests against `test/fake-world.ts` routes that follow the vendor's
   documented behaviour (the fake is the reference for the twin we ask for).
4. FetchSandbox contract with executable checks for every promised
   behaviour, including those that need missing twins.
5. Relay proof; receipt committed; each non-held check traced to a twin,
   engine or app cause in FETCHSANDBOX_GAPS.md.
6. `cdk synth` for the AgentCore stack.

## Sources

- AP and three-way match: [Vroozi](https://www.vroozi.com/blog/how-agentic-ai-could-reduce-invoice-exceptions-in-accounts-payable/), [Gravitee three-way match controls](https://gravitee.io/corpus/gen-2446/purchase-to-pay/three-way-matching-automation.html), [Infosys BPM P2P](https://www.infosysbpm.com/offerings/functions/finance-accounting/insights/documents/the-rise-of-agentic-ai-in-procure-to-pay-from-basic-automation-to-autonomous-finance-agents.pdf)
- Supplier onboarding and bank changes: [Corpay](https://www.corpay.com/nl-NL/resources/blog/vendor-verification-banking-validation), [Dost](https://www.dost.io/blog/vendor-verification-how-to-detect-fraudulent-suppliers-before-you-pay-them), [Kognitos vendor onboarding](https://www.kognitos.com/blog/vendor-onboarding-automation-application-to-approval-2026/), [apexanalytix](https://www.apexanalytix.com/resources/blog/supplier-onboarding-checklist/)
- Close: [Datarails](https://www.datarails.com/month-end-close-automation), [Redwood](https://www.redwood.com/solutions/finance-automation/financial-close-checklist), [Rillet](https://www.rillet.com/blog/financial-close-automation)
- Access reviews: [Zluri](https://www.zluri.com/eye-on-identity/automated-user-access-entitlement-reviews-soc2-hipaa-sox), [Thoropass](https://www.thoropass.com/blog/stop-doing-user-access-review-the-old-way), [CloudNuro](https://www.cloudnuro.ai/blog/user-access-review-frequency-by-industry-and-framework)
- Final pay: [ComplianceHR](https://compliancehr.com/2025/12/22/how-long-do-employers-have-to-issue-a-final-paycheck/), [Gusto dismissal flow](https://sdk.gusto.com/docs/reference/payroll/dismissal-flow), [ADP off-cycle payroll](https://www.adp.com/resources/articles-and-insights/articles/o/off-cycle-payroll.aspx)
- Durable execution patterns: [Temporal use cases](https://docs.temporal.io/evaluate/use-cases-design-patterns)
- Broad adoption: [AppZen](https://appzen.com/blog/why-ai-agents-will-become-an-enterprise-reality-in-2026), [Workato onboarding/offboarding recipes](https://www.workato.com/product-hub/automating-employee-onboarding-and-offboarding-5-recipes-to-streamline-hr-and-it-ops/)

Most of these are vendor or practitioner sources; their claimed percentages
are not relied on here, only the process shapes and controls they describe.
