# Acme AgentCore release — 17 October 2026

Account `342206308838`, region `us-west-2`. Recorded 2026-10-17T19:14:10.017981+00:00.

## Measured scope

- PR #42 was merged first with a two-parent merge commit (`6e31e3568e17638d176ddf71b101362009a162d0`). PRs #43–61 were subsequently merged with merge commits.
- Nineteen workflow runtimes expose the expected live manifest, reject an invalid command, identify owner Raj / Acme / production, and have 14-day log retention. These are basic runtime checks, not end-to-end tests for every workflow.
- Deployment: `acme-ops-2.0.1-shared-trace-delivery`, source `c4a5e140bb257c538c91e863bc1abfd5c08559b0`. The quota fix reused an already-authorized regional delivery policy. All nineteen application container artifacts were unchanged by that infrastructure fix.
- This rollout contains 64 named agent/composer steps across 10 explicit departments. These are functions/stages inside nineteen runtimes, not 64 independent AgentCore runtimes or necessarily 64 LLM agents.
- Account inventory: 22 business workflows and one additional handoff operator runtime (23 runtimes). Four runtime versions belonging to the three older business workflows/operator remain unchanged. Their historical ownership labels are separate from the new ten-department taxonomy; no unsupported aggregate department count is inferred.
- Fresh published-MCP contract results: 2 verified, 11 inconclusive, 6 failing; 169 held, 6 violated, 101 unmeasured checks. Each receipt is separate; these counts are an inventory, not a merged proof.
- Local validation: 64 tests across 23 files passed; TypeScript and bundling passed. No workflow business definitions or declared contract assertions were changed. No bug was injected and no before/after application-fix proof is claimed.
- Validation used production FetchSandbox through published MCP `0.7.28`. Disposable keys were used for all nineteen runs and exact-key revocation was confirmed. The application version in a relay receipt is declared, not remotely attested.
- LoopLabs remains observation-only. No new cross-account invocation role was created. LoopLabs sync/import/execution was not exercised. These workflow triggers are IAM-authenticated AgentCore API commands; this package does not install native Slack listeners, Gmail watches, or schedules. The MCP runs are scripted-contract tests, not fresh Cursor/Claude persona acceptance runs.

## Workflow matrix

Checks are held / violated / unmeasured. Every AWS cell below refers only to the basic live runtime checks above.

| Workflow | Department | Agent steps | MCP verdict | Checks H / V / U | AWS runtime version | Receipt |
|---|---|---:|---|---|---|---|
| access-jml | IT | 2 | inconclusive | 16 / 0 / 2 | 1 — basic checks passed | [receipt](https://fetchsandbox.com/runs/7a9c003323?flow=vr_8f424980f3264bb186ddedec1a3fcaf5) |
| churn-risk-sweep | Customer Success | 6 | failing | 0 / 1 / 13 | 4 — basic checks passed | [receipt](https://fetchsandbox.com/runs/44486f9519?flow=vr_ac7169a9f01c42c4a7f7d18cc9752f1f) |
| collections-credit-hold | Finance | 2 | verified | 13 / 0 / 0 | 2 — basic checks passed | [receipt](https://fetchsandbox.com/runs/b6bdad9b8a?flow=vr_3189eb3eefb548b6971e0f0388bc4677) |
| compliance-docs | Quality | 4 | inconclusive | 9 / 0 / 2 | 1 — basic checks passed | [receipt](https://fetchsandbox.com/runs/6536effa7a?flow=vr_55b45ff32c8d4cbcbc7223b26ef54ff9) |
| distributor-claims | Finance | 3 | inconclusive | 12 / 0 / 1 | 1 — basic checks passed | [receipt](https://fetchsandbox.com/runs/d1c6416037?flow=vr_f08e62448f894fc89281c5bc1f7fbc6b) |
| export-screening | Trade Compliance | 3 | inconclusive | 13 / 0 / 1 | 1 — basic checks passed | [receipt](https://fetchsandbox.com/runs/a16f3105cf?flow=vr_3ccc757878dd4543aa30340c9af27b89) |
| field-service-dispatch | Service | 4 | failing | 0 / 1 / 15 | 1 — basic checks passed | [receipt](https://fetchsandbox.com/runs/437c2057c7?flow=vr_586fce3057124100b736f1ffcd33c811) |
| incident-comms | IT | 2 | inconclusive | 14 / 0 / 3 | 1 — basic checks passed | [receipt](https://fetchsandbox.com/runs/8fdbbc52d2?flow=vr_3980d8f9fe1d4447bf51e0e8cd09dd35) |
| license-reclaim | IT | 1 | inconclusive | 14 / 0 / 1 | 1 — basic checks passed | [receipt](https://fetchsandbox.com/runs/4feb7241b7?flow=vr_1e6bed2f16c94b93a30e536aa13a2bdf) |
| onboarding-kickoff | Sales | 5 | failing | 0 / 1 / 14 | 4 — basic checks passed | [receipt](https://fetchsandbox.com/runs/eb63f63b87?flow=vr_96ee3edd48ca4d1988ee7a33da52d677) |
| order-status | Customer Experience | 4 | inconclusive | 14 / 0 / 2 | 2 — basic checks passed | [receipt](https://fetchsandbox.com/runs/0894cec887?flow=vr_0d112538fd5442829fa2a086d55aa10b) |
| pcn-eol-notice | Engineering | 3 | verified | 13 / 0 / 0 | 1 — basic checks passed | [receipt](https://fetchsandbox.com/runs/507b79e157?flow=vr_5757601ad1f5497d85d60812687c8343) |
| returns-warranty | Customer Experience | 4 | inconclusive | 14 / 0 / 3 | 1 — basic checks passed | [receipt](https://fetchsandbox.com/runs/80f8ee890c?flow=vr_95aece181fdf4e33bd55f27e6490eea4) |
| revenue-reconciliation | Finance | 3 | inconclusive | 12 / 0 / 1 | 5 — basic checks passed | [receipt](https://fetchsandbox.com/runs/b29c0a66a5?flow=vr_a6e43ac08b4542b390f5acd8a98e453d) |
| rfq-quote | Sales | 4 | inconclusive | 14 / 0 / 2 | 2 — basic checks passed | [receipt](https://fetchsandbox.com/runs/711bc49078?flow=vr_8aca9d37a07749d4bbc2790ebcf3f582) |
| security-questionnaire | IT | 3 | inconclusive | 11 / 0 / 1 | 1 — basic checks passed | [receipt](https://fetchsandbox.com/runs/43a56200eb?flow=vr_ac51b2947ccc412c90eec4f6956c89f9) |
| service-renewals | Customer Success | 3 | failing | 0 / 1 / 12 | 1 — basic checks passed | [receipt](https://fetchsandbox.com/runs/0f93ca6e8b?flow=vr_8d6d3a605419402b9102ad46a0fb10e4) |
| supplier-ncr | Quality | 3 | failing | 0 / 1 / 13 | 1 — basic checks passed | [receipt](https://fetchsandbox.com/runs/654fbe9698?flow=vr_432cdc4487734de899eba23a3e5ca048) |
| support-escalation | Support | 5 | failing | 0 / 1 / 15 | 5 — basic checks passed | [receipt](https://fetchsandbox.com/runs/7e53650058?flow=vr_aec0a91bce0646dfb4c50fa02a504518) |

### Three earlier business workflows (preserved)

| Workflow | Existing ownership group | Logical agent count and basis | Runtime version preserved |
|---|---|---|---|
| Original quote agent | Acme Revenue Operations — Sales Support and Quote Operations | 1 application-level Quote agent; source README describes one classifier/orchestrator workflow | 16 |
| Customer operations | Acme Customer Operations — Customer Success and Billing Operations | 6 agent modules: intake, research, quote, billing, survey, handoff. Dispatch is a subsequent action stage, not an additional agent module | 1 |
| Customer handoff | Acme Customer Onboarding Operations — Customer Onboarding and Billing Operations | 5 manifest roles: quote, research, CRM, billing, messaging | 2 |

The handoff operator is a separate control runtime (version 2), not another business workflow. Legacy agent counts are source/previous-manifest inventories; their full business paths were not rerun in this rollout. Their versions were independently checked against the pre-rollout AWS inventory. The new batch's 64-step count is confirmed by all nineteen live manifests.

## Live native-provider sanity tests

Two workflows were invoked from the Mac through the AWS IAM API against real providers (Stripe test mode). Their unchanged container artifact was tested before the metadata/quota rollout; fresh-session status and provider read-backs were checked after deployment. These are separate from their isolated-twin receipts.

| Workflow | Trigger and result | Independent provider evidence | Remaining limits |
|---|---|---|---|
| RFQ quote | 0% discount, two $10 demo items; all four agent steps and six actions applied | Native Stripe quote `qt_1URclsLMwbLY0hYjLBZaxoUj` is open, test mode, total 2000 cents; Gmail draft read back with DRAFT label; Slack message read back | Does not prove real discount application, every price boundary, or live charges |
| Order status | Late demo shipment parked with two gated actions; duplicate start reused the run; unauthorized approver got application 403; Raj approved; all four actions applied | Asana task `1219618158061740` moved from 2026-10-16 to 2026-10-20 and reconciled match; both Gmail drafts read back with DRAFT labels; Slack alert read back | Built-in Gmail/Slack reconciliation remains unverifiable; independent provider reads are separate evidence. No emails were sent |

Application wording gaps: the Asana comment says "customer notified" although this workflow creates a draft, and its Slack alert remains the original approval-pending message. Those existing business/message definitions were preserved, not silently patched for the demo.

## Provider connections and remaining gaps

Asana demo PAT was approved, created, tested with three HTTP 200 connection reads, and installed only in workflows that declare Asana. All such installed secrets were read back. Existing Stripe, HubSpot, Gmail, Calendar, Slack and Zendesk connections were preserved.

Unconfigured native providers remain explicit: WorkOS (phone verification), Box and Notion (signup/terms/access steps pending), Twilio (signup plus phone verification), PagerDuty (business-account setup), Trade.gov (account/password/API subscription), and GitHub (no workflow-scoped API credential configured). No fake credentials or provider responses were substituted.

All six failing twin baselines hit Calendar `POST /calendar/v3/freeBusy` returning 501 not_simulated. Churn-risk also hits Gmail message-list 501. Checks not run after a failed baseline remain unmeasured.

Other unmeasured entries include Stripe invoice lines/quote discounts, Box/Notion/Asana/WorkOS/PagerDuty fixture behavior and systems outside these contracts. The original contracts excluded Zendesk and retain stale absence explanations; current production MCP does discover a bounded Zendesk twin. Required Zendesk operations and contracts need reassessment, rather than counting discovery as full integration verification.

## Evidence files

- `final-runtime-inventory.json`: runtime ARNs/versions, source metadata, owner/departments, agent names, and preserved legacy versions.
- `FRESH-MCP-RESULTS.md`: all nineteen receipts and per-check explanations.
- `fresh-proof-gaps.json`: baseline agent errors and unmeasured reasons.
- `*-runtime-gate.json`: live manifests, invalid-command refusal and log retention/delivery observations.
- `*-live-*.json`: native scenario state summaries and independent provider reference read-backs.
- `existing-state-secret-preservation.json`, `shared-trace-synth-checks.json`, `shared-trace-application-artifact-preservation.json`: deployment safety comparisons.
- `disposable-credential-cleanup.json`: nineteen independently confirmed key revocations and removed temporary credential copies.
