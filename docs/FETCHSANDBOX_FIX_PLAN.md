# FetchSandbox gap fixes and proof plan

As of **October 27, 2026**. Owner: **FetchSandbox engineering**; Raj is the
accountable product owner. This is an execution estimate and evidence overlay,
not a claim that the remaining fixes have shipped.

[Catalog](WORKFLOWS.md) · [Original R1–R26 report](FETCHSANDBOX_GAPS.md) ·
[Builder history](TRACKER.md) · [Sanitized status record](evidence/fetchsandbox-gap-status-2026-10-27.json)

## What is measured now

Main `0da1ca6` has 51 Acme workflow definitions and 152 logical roles. The separate
Customer Operations package and three branch examples are not part of that count.
This is repository inventory, not deployed AgentCore inventory.

The public backend build endpoint reports `51284f50` at this audit; its environment
field is `unknown`. This identifies the measured release at the public origin,
not an independent infrastructure attestation. Engine source/release review is
separate from this public workflow repository.

| Item | Measured scope | Still required |
|---|---|---|
| R3 customer pagination | [October 27 sweep receipt](https://fetchsandbox.com/runs/0978965681?flow=vr_e3c8446a1e2b43628bd85ab307355788): eight declared checks passed, including 250 customers across three pages, incomplete-scan refusal, approval cap and rerun behavior; app-declared `c2ec0d5`, backend `51284f50` | Search fidelity; 5,000-record seed benchmark; native acceptance. Fixture retry/isolation changed, so this is not a byte-identical whole-contract before/after run. It does not prove current main. |
| R26 Notion identity | Focused dashed/undashed page identity/read-update tests; included in `51284f50` | Original visa/leave workflow rerun and native acceptance; other Notion fidelity remains unqualified. |
| Validation ownership/JWT | Bounded owner/foreign/anonymous live checks and own-resource cleanup; existing spend gate retained | Wider client regressions; not every historic ownerless resource can be classified. |
| Cold parsing/relay responsiveness | Cold-load wire regression and original three-provider sweep setup/execution | All-provider/concurrency coverage and full R13 allowance acceptance. |
| Latest native agent | `p5_crossservice-20261027T035406Z`, published MCP `0.7.30`, clean source `148501b36`, backend `51284f50`: **UNMEASURED** | Validation-tool acceptance and a measured code-fix proof remain missing. Do not substitute the deterministic sweep pass. |
| Persisted sandbox reload | Reproduced: stored sandbox records absent from live runtime after restart under lazy startup | Unfixed. Safe on-demand rehydration, owner isolation and mutation persistence; do not eagerly load every stored resource into memory. Saved receipt read-back is a separate path. |

**No complete R1–R26 requirement is closed.** R3 and R26 have bounded partial fixes.
The related address-form fix does not close R20's distinct acceptance criteria.
The other requirements retain historical findings until a current reproduction
establishes which part is an engine defect, missing operation or fixture mistake.

## Delivery sequence and estimates

All dates below are **Pacific time**, planning targets rather than achieved dates.
Assume one engineer working primarily on this scope, functioning production/MCP
access and no additional vendor qualification blockers. Deliver small reviewable
changes throughout; do not wait for the whole program to publish evidence.

| Phase | Priority / target | Deliverable and estimated effort | Exit gate |
|---|---|---|---|
| Documentation baseline | October 27 | Correct catalog/tracker contradictions, preserve dated failure evidence, assign every R ID and proof gate; under one day | Documentation drift/link checks; reviewed change on main. A PR alone is not an applied catalog fix. |
| A: reliability and requalification | P0 first; target October 30 | Persisted-sandbox reload; remaining ownership/relay cleanup and native acceptance diagnosis. Refresh affected discovery and prioritize reproduced failures. 2–3 engineering days | Original stored state survives actual restart without cross-owner access; receipts remain readable; own resources/keys/leases cleaned; unchanged native flow measured or explicitly failed/unmeasured. Publish revised estimates by October 30. |
| B: first provider-fidelity batch | P1; target November 6 | R3, R26, R9, R20, R24 narrow operations, delivered one at a time. 4–6 engineering days, overlapping qualification only | Original affected workflow checks re-executed with exact setup differences disclosed; unresolved subrequirements stay open. |
| C: shared behavior and existing-provider expansion | P1; subsequent 2–4 engineering weeks | R1/R2/R7/R8/R10/R11/R12/R15/R18/R21/R22/R23/R25. Runtime clock, billing and identity correctness precede dependent workflow claims | Schema/fault/state regressions, same business contract reruns, tool/caller telemetry, private handoff and required native acceptance. |
| D: missing-provider packs | P2; subsequent 2–4 engineering weeks | R4/R5/R14/R16/R17/R19: split R14 into individual provider contracts before sizing. Scope vendor surfaces needed by these apps, not whole-vendor parity | Public MCP discovery, isolated fixtures, fault controls, stateful writes/read-back and original business workflow receipts per provider. |
| Final replay | After dependencies; 3–5 engineering days | Replay the original affected workflow cohort, then relevant existing provider/client regressions on one pinned release | Every agreed relevant check measured; no removed failures, no merged receipts, no unrun native path called accepted. |

**Whole-program provisional envelope: 6–10 engineering weeks.** This is not a
promised all-fixed calendar deadline. The phase estimates overlap and have unknowns;
missing-provider licensing/auth/version work can extend them. Re-estimate after
Phase A rather than assert an unsupported completion date. New P0 findings take
precedence and must update this table with their effect on the schedule.

## R1–R26 ownership and acceptance queue

Priority is delivery order, not a statement that financial/security behavior is
safe to ignore. A P2 provider remains an explicit unsupported/unmeasured dependency
until its scoped pack passes. All rows are owned by FetchSandbox engineering.
Original detailed operation evidence stays in the linked R report.

| ID | Priority / phase | Requirement | Current status | Next closure evidence |
|---|---|---|---|---|
| R1 | P1 / C | Scripted model replies | Open; current requalification pending | Return chosen schema-shaped assistant output; measure unsafe-answer refusal. Template runs do not satisfy this. |
| R2 | P1 / C | Stripe failed-collection lifecycle | Open; current requalification pending | Invoice items/amounts, failed pay and attempt counts, signed failure delivery and dunning outcomes agree. |
| R3 | P1 / B | Pagination and bulk fixtures | Partial, deployed | Keep the 250-customer/three-page pass; prove query filtering and seed 5,000 records in under a minute. |
| R4 | P2 / D | NetSuite order records | Open; current requalification pending | Discover provider, create one external-ID sales order, read/query it and observe it in order-to-cash. |
| R5 | P2 / D | Carrier shipping | Open; current requalification pending | Buy one label, refuse duplicate buy and reconcile tracking to the correct storefront order. |
| R6 | P1 / C | Shopify state/version fidelity | Open; current requalification pending | Pin a currently supported version; stateful orders and order-scoped fulfillment read-back, then order-to-cash rerun. |
| R7 | P1 / C | Independent operator writes | Open; current requalification pending | Apply authorized metadata change between planning and approval; original race check observes it. |
| R8 | P1 / C | WorkOS sessions/memberships | Open; current requalification pending | Stored roles, membership transitions and user-scoped revocation read back correctly; containment rerun. |
| R9 | P1 / B | Zendesk locale/search | Open; current requalification pending | Qualify documented locale_id/user-update semantics first; locale formatting and ticket search/deduplication rerun. |
| R10 | P1 / C | Stripe tax/settlement | Open; current requalification pending | Realistic calculated line amounts and refund exchange-rate/balance record read-back; cross-border checks. |
| R11 | P1 / C | Response loss behind proxy | Open; current requalification pending | Witness accepted effect/lost response and exactly one effect after retry from proxied runtime. |
| R12 | P1 / C | Webhook/check correlation | Open; current requalification pending | Signed event starts a runtime run attributable to the exact original check; no supplied-answer seeding. |
| R13 | P1 / A | Relay allowance and cleanup | Open; current requalification pending | Back-to-back proofs including failed setup release their own leases; next proof starts within one minute. |
| R14 | P2 / D | Other missing/partial provider surfaces | Open; current requalification pending | Split broad requirement into provider-specific scoped contracts; discover, execute and read back each relevant business effect. |
| R15 | P1 / C | Runtime clock during attempt | Open; current requalification pending | Controlled test-only app clock advances mid-attempt, tick changes saved state and time step appears in receipt; production clock route disabled. |
| R16 | P2 / D | Gusto payroll | Open; current requalification pending | Version-guarded termination and off-cycle pay submit/read-back; final-pay and payroll-anomaly workflow proof. |
| R17 | P2 / D | Modern Treasury payments | Open; current requalification pending | One payment per idempotency key, authorized transitions and later returned-payment observation. |
| R18 | P1 / C | GitHub reviews/deployments/access | Open; current requalification pending | Seed actual approvals/checks; observe deployment, membership and security-alert effects in applicable original workflows. |
| R19 | P2 / D | DocuSign lifecycle | Open; current requalification pending | One envelope per contract, status/reminder/void state; original contract-intake time checks. |
| R20 | P1 / B | Scalar/ID and creation fidelity | Open; current requalification pending | Payout epochs, Plaid token shape and 250 creates eight-wide with bounded retry; address fix alone is insufficient. |
| R21 | P1 / C | Datadog degradation | Open; current requalification pending | Change a monitor after deployment, observe rollback on GitHub, retain earlier missing-credential setup failure. |
| R22 | P1 / C | HubSpot properties/consent | Open; current requalification pending | Define and read back properties and subscription state; consent/CRM/lead-routing workflow reruns. |
| R23 | P1 / C | Pinned API versions | Open; current requalification pending | Record the supported vendor version per provider, verify relevant shapes/headers; do not claim all-version parity. |
| R24 | P1 / B | Box stored files | Open; current requalification pending | Vendor-shaped file IDs; upload then read/representation extraction on the same stored file. |
| R25 | P1 / C | Stripe metered usage | Open; current requalification pending | 1,300 seeded units read back as 1,300 with correct invoice linkage and usage-true-up result. |
| R26 | P1 / B | Notion page identity/state | Partial, deployed | Retain dashed/undashed identity tests; run original visa/leave create/read/update checks and inspect receipt. |

## Qualification corrections and dependency order

- **Zendesk R9:** ticket creation documents `requester.locale_id`; it does not
  establish that `requester.locale` is a valid creation field. Existing users are
  reused without profile updates. Qualify a documented user-update path before
  changing the twin; retain the old failing payload as fixture evidence.
- **R6/R23 versions:** historical Shopify version strings are reproductions, not
  current support promises. Record a supported version from primary vendor docs
  and test the exact versioned path/header used by each app.
- **R15 versus R2:** app clock control and provider billing lifecycle are separate.
  Advancing app time does not simulate Stripe invoice collection. Prove both before
  claiming end-to-end dunning, and keep test controls disabled in deployed adapters.
- **R18/R21:** GitHub deployment state must exist before claiming a Datadog-driven
  rollback; a degraded synthetic monitor alone is not a rollback result.
- **Missing providers:** new spec registration alone does not qualify a twin.
  Discoverability, state, faults and original app acceptance are separate gates.

## Proof required for each delivery

1. Record original workflow/source revision, check IDs, pinned provider versions,
   public MCP version and backend build. Reproduce the precise failure first;
   unsupported/setup failures stay separate from application defects.
2. Implement in the existing owner path. Preserve the business expectations;
   disclose fixture/setup changes and retain the previous receipt.
3. Run focused and relevant existing regressions. For API/MCP/background changes,
   verify existing durable usage telemetry: caller/provider attribution, failure
   outcome, redaction and durable read-back. No parallel analytics system.
4. Deploy the selected immutable release, rerun the original affected app/checks,
   independently inspect saved state and keep each receipt distinct. Include
   failed, unmeasured, skipped and blocked checks in the delivery record.
5. Use the existing unchanged native-agent acceptance flow where required. A
   deterministic runner, HTTP 200 or scheduling acknowledgement cannot replace it.
6. Discover the shipped operation through the public MCP. Record commit, deployed
   version, check outcomes, receipt URL and remaining limits here and in the guide.
   Close an R ID only after **all** its acceptance criteria pass.

This documentation change executes no workflow, makes no new production change
and does not supersede the original report's failures. The latest sweep receipt
is linked as additional dated evidence; the old checked-in receipt is preserved.
