# acme-ops

[Business guides for every workflow](../docs/WORKFLOWS.md) · [Coding-agent verification loop](../AGENTS.md) · [Proof scope and limits](../docs/VERIFICATION.md)

Twenty ACME operations workflows across ten departments, each a **standalone Amazon Bedrock AgentCore
runtime**. Each runtime runs several agents in parallel across Zendesk,
HubSpot, Gmail, Stripe, Google Calendar and Slack. Each one speaks the
AgentCore HTTP contract (`POST /invocations`, `GET /ping` on `:8080`), so a
control plane such as LoopLabs can import it, start runs, approve gated
actions, read every agent's output and action, and reconcile what was written.

This package is the shared kit (engine, AgentCore server, provider clients, deploy infra, proof runner).
Each workflow is one file in `src/workflows/` plus its contract, receipt and tests, and ships in its own
PR; there is no central registry, so `WORKFLOW=<file name>` selects it at runtime and `cdk` adds one stack
per file.

| Workflow | Org · team | What it automates | Needs approval |
|---|---|---|---|
| [`support-escalation`](src/workflows/support-escalation.ts) | Support · support-ops | Triage a ticket against CRM, billing and the support lead's calendar; escalate, hold a callback, draft the reply | Public Zendesk reply |
| [`returns-warranty`](src/workflows/returns-warranty.ts) | Customer Experience · cx-service | Warranty check on the invoice, RMA task for the returns dock, RMA instructions draft | Credit / refund |
| [`product-cancellation`](src/workflows/product-cancellation.ts) | Customer Experience · cx-retention | Email/phone cancellation → Zendesk ticket and acknowledgement, policy research, cancel in policy, refund offer; the customer's choice → Stripe refund, store credit or Square gift card, confirmed on the ticket | Cancelling outside policy; refunds above $500 |
| [`order-status`](src/workflows/order-status.ts) | Customer Experience · cx-service | Answer "where is my order" from the invoice and warehouse task; alert the owner on late orders | Promise-date change |
| [`compliance-docs`](src/workflows/compliance-docs.ts) | Quality · quality-compliance | Find RoHS/REACH/CoC/calibration documents for a part, or route to Quality | External share link + reply |
| [`field-service-dispatch`](src/workflows/field-service-dispatch.ts) | Service · field-service | Site alarm: technician availability, contract coverage, work order, SMS to the site | After-hours or billable booking |
| [`rfq-quote`](src/workflows/rfq-quote.ts) | Sales · sales-ops | RFQ to priced Stripe quote under a discount policy; CRM and customer ensured | Discount above policy (finalize) |
| [`onboarding-kickoff`](src/workflows/onboarding-kickoff.ts) | Sales · sales-ops | Closed-won: CRM customer, Stripe customer, Zendesk org, welcome draft, Slack handoff | Subscription, kickoff invite |
| [`churn-risk-sweep`](src/workflows/churn-risk-sweep.ts) | Customer Success · cs-ops | Weekly risk score per account; digest, check-in drafts | QBR invites |
| [`service-renewals`](src/workflows/service-renewals.ts) | Customer Success · cs-ops | 90/60/30-day renewal sweep of monitoring and calibration contracts; tasks and drafts | Price uplift above policy |
| [`revenue-reconciliation`](src/workflows/revenue-reconciliation.ts) | Finance · revops-finance | Stripe payers vs HubSpot customers vs approved refunds; variance report | CRM fixes |
| [`collections-credit-hold`](src/workflows/collections-credit-hold.ts) | Finance · ar-collections | Tiered reminders for past-due invoices; AR digest | Credit hold |
| [`distributor-claims`](src/workflows/distributor-claims.ts) | Finance · channel-finance | Validate distributor claims against invoices, prices and agreement | Paying the credit |
| [`pcn-eol-notice`](src/workflows/pcn-eol-notice.ts) | Engineering · product-engineering | Product change / EOL record → affected customers and owners | Customer notices |
| [`export-screening`](src/workflows/export-screening.ts) | Trade Compliance · trade-compliance | Classification, embargo and restricted-party checks; hold the order when anything is unclear | Releasing a hold |
| [`supplier-ncr`](src/workflows/supplier-ncr.ts) | Quality · supplier-quality | Failed inspection → CAPA task, 8D request draft, review hold | Supplier hold notice |
| [`access-jml`](src/workflows/access-jml.ts) | IT · it-identity | Joiner/mover/leaver in the directory, IT ticket, manager notice | Privileged roles, leaver removal |
| [`license-reclaim`](src/workflows/license-reclaim.ts) | IT · it-asset-mgmt | Find idle seats, warn, reclaim after grace | Reclaim |
| [`security-questionnaire`](src/workflows/security-questionnaire.ts) | IT · it-security | Answer from the approved library, flag new questions to Security | Sending answers |
| [`incident-comms`](src/workflows/incident-comms.ts) | IT · it-operations | PagerDuty incident → note, war-room post, affected customers | Customer notices |

Design rules shared by the Acme workflows:

- **Agents read; actions write.** Agents gather and judge in parallel. Every
  side effect is a planned, named action with a gate (`auto` or `approval`), a
  summary for the approval card, and an optional read-back for reconciliation.
- **Models write words; code makes decisions.** Claude (`claude-opus-5-5`,
  when `ANTHROPIC_API_KEY` is set) drafts replies, briefs and check-ins.
  Severity, risk scores, ledger matching, prices, recipients and gating are
  all computed in code. Customer-facing mail is created as a Gmail *draft*.
  Without a key, deterministic templates are used and `draftedBy: "template"`
  says so.
- **Nothing is faked.** A provider with no credentials is *not configured*. Its
  agents are `skipped` and its actions are recorded as `skipped / not_configured`.
- **Independent.** Each runtime has its own image (`--build-arg WORKFLOW=…`),
  its own DynamoDB table and its own secret. They share source code, not state.

## Control API (`POST /invocations`)

| Command | Fields | Returns |
|---|---|---|
| `describe` | — | Owner org and team, agents and the providers they need, every action kind with its gate, input JSON Schema |
| `start` | `runId?` (idempotency key, e.g. the trigger's event id), `input`, `requestedBy {userId}`, `labels?`, `wait?` (default `true`) | Run view. Repeating a `runId` returns the existing run with `duplicate: true` and bumps `duplicateStarts` |
| `status` | `runId` | Run view |
| `decide` | `runId`, `decision: approve\|reject`, `userId` | `result`: `recorded`, `already_decided`, `forbidden` (HTTP 403), `expired`, `not_ready`, `closed` |
| `cancel` | `runId`, `userId` | `cancelled` (while awaiting approval), `cancelling` (mid-flight), `not_cancellable` |
| `resume` | `runId` | Continues a stalled run from its last checkpoint, or retries failed effects of a parked or finished run |
| `reconcile` | `runId` | Re-reads every applied effect from its provider and records `match`, `drift`, `missing` or `unverifiable` per action |

The **run view** is the control plane's single source of truth:

```jsonc
{
  "runId": "zd-4242", "workflow": "support-escalation", "org": "Support", "team": "support-ops",
  "phase": "AWAITING_APPROVAL",            // RUNNING → AWAITING_APPROVAL → APPROVED → DONE | REJECTED | EXPIRED | CANCELLED
  "outcome": "partial",                    // ok | partial | failed | pending
  "agents":  [{ "name": "billing-health", "status": "failed", "errorCode": "stripe:api_key_invalid", "durationMs": 212 }, …],
  "actions": [{ "id": "slack.post_escalation", "provider": "slack", "gate": "auto", "status": "applied", "ref": "1792…", "attempts": 1, "reconciled": null },
              { "id": "zendesk.public_reply", "gate": "approval", "status": "pending_approval", "summary": { "preview": "Hi Alice, …" } }, …],
  "approval": { "approvers": ["U_LEAD"], "expiresAt": "…" },
  "counts":   { "applied": 3, "failed": 0, "pendingApproval": 1, "skipped": 1, "rejected": 0 },
  "output":   { "severity": "urgent", "escalated": true, … },
  "duplicateStarts": 0, "events": [ … ]
}
```

### How runs stay correct

| Situation | Handling |
|---|---|
| Trigger delivered twice or concurrently | `start` is a put-if-absent on `runId`. Later deliveries return the same run (`duplicateStarts` counts them) |
| One provider down or refusing | That agent becomes `failed` with a typed `errorCode` (e.g. `slack:channel_not_found`) and the rest carry on. Reconciliation refuses to compare against a ledger it couldn't read |
| Retried or concurrent side effect | Each effect is claimed in the store (`effect#run#action`) before it runs and records its receipt. A retry copies the receipt instead of repeating the effect. Stripe customers are looked up at write time, because the twin ignores `Idempotency-Key` |
| Re-fired business event (e.g. closed-won twice) | Plans read current provider state: an existing live subscription to the same price means no new subscription is proposed, and the approval step re-checks before creating one |
| Crash or redeploy mid-run | Every phase is a compare-and-swap checkpoint in DynamoDB. `resume` continues from it without re-running finished agents or applied effects |
| Approval races, strangers, late clicks | One conditional `AWAITING_APPROVAL → APPROVED/REJECTED` wins, others get `already_decided`. Non-approvers get `403 forbidden`. Approvals expire after `APPROVAL_TTL_HOURS` |
| Things changed after we wrote them | `reconcile` re-reads HubSpot contacts, Stripe customers and subscriptions, Zendesk tickets and Calendar events, and reports drift (e.g. seats changed by hand) |
| Prompt injection via tickets or emails | Customer text only reaches the drafter, wrapped as untrusted `<facts>`. Drafts are never sent automatically, and Slack text is stripped of markup |

## Run locally

```bash
cd acme-ops
npm install
npm test                       # tests: duplicates, races, faults, approvals, expiry, restart, resume, reconcile, HTTP contract
npm run bundle
WORKFLOW=onboarding-kickoff STATE_FILE=.state/runs.json node --env-file=.env dist/main.mjs
curl -s localhost:8080/invocations -d '{"action":"describe"}'
```

## Prove it against FetchSandbox twins (managed relay)

`verify/relay-proof.mjs <workflow>` runs the **real container entry point** on
a loopback port and proves it through FetchSandbox's managed relay:

1. `manage_tunnel open` exposes the runtime to the verifier only. No ngrok is
   needed, and direct requests get a 404.
2. `validate_integration { providers, app_base_url }` creates isolated twins.
   The runtime is restarted with each provider's `<P>_BASE_URL` / `<P>_API_KEY`
   pointed at them.
3. `application_workflow_v1` is configured from
   [`verify/contracts/<workflow>.mjs`](verify/contracts). Every action is the
   runtime's own `POST /invocations`. Every observation reads saved run state
   from `GET /verify/runs/{run}/cases/{case}/runs`, which is bearer-protected
   by the verifier token and exists only when `FETCHSANDBOX_VERIFIER_TOKEN` is
   set. AgentCore never routes it.
4. `install_test_credentials` writes the private handoff file. It's loaded with
   `node --env-file` and never read or printed. `X-Flow-Run-Id` is stamped on
   every provider call.
5. Preflight, execute once, poll the same run. The receipt goes to
   `verify/receipts/<workflow>.json`.

```bash
npm run bundle
node verify/relay-proof.mjs support-escalation
```

Each contract covers the happy path and approve, reject and stranger-approval
paths. It also covers duplicate and 4× concurrent triggers, input
validation, and provider faults armed on the twins (auth failures, rate
limits, Slack `channel_not_found` / `not_in_channel`). All 17 FetchSandbox
coverage dimensions are reviewed. Anything that can't be exercised yet is
declared as a **blocked** check with evidence, never dropped.

### Results

All 19 runtimes are relay-proven: **251 executable checks held, 0 violated**, every check driven twice
with identical saved state, each contract including a real process restart. 25 checks are declared
blocked because the system they need has no faithful FetchSandbox twin (Zendesk, ERP, Salesforce,
carriers, restricted-party screening, Okta/Google Admin, or twins that return sample data). Workflows
without such gaps are *verified*; the others read *inconclusive* until those twins exist. The proofs
caught real bugs (a duplicate subscription on a re-fired trigger, mixed-interval quotes, a reclaim
safety check that blocked every reclaim, unbounded directory paging), all fixed and regression-tested.

Per-check results, receipt links and the twin findings: run `node verify/results.mjs`, which renders
`verify/RESULTS.md` from the receipts in `verify/receipts/` (one per workflow, committed with it).

## Product cancellation and refunds

[`product-cancellation`](src/workflows/product-cancellation.ts) is one runtime with two entry stages, because the
customer answers in between:

```
stage "request"  (Zendesk trigger: ticket created from an email or call; or a phone event without a ticket)
  agents ∥ ticket-context (Zendesk) · policy-research (Stripe subscription, product terms, last payment, prior refunds)
         · gift-card-desk (Square location)
  → zendesk.create_ticket (phone, no ticket) → zendesk.acknowledge (public reply: how cancellation works)
  → zendesk.policy_note (internal: research + decision + policy version)
  → stripe.cancel_subscription        auto when the policy allows it, APPROVAL for an exception (commitment term)
  → zendesk.refund_offer              "reply 1 / 2 / 3", only the methods the policy allows; tags cxl_refund_offer
    or zendesk.cancellation_confirmed (no refund due; solves the ticket)
  → slack.post_case

stage "refund_choice"  (Zendesk trigger: the requester replies on a cxl_refund_offer ticket, or sets the refund field)
  agents ∥ ticket-context (requester's reply → choice) · policy-research (re-reads the offer recorded on the
         Stripe subscription, re-checks what is still refundable) · gift-card-desk
  → stripe.refund_original_payment | stripe.issue_store_credit | square.issue_gift_card
                                      auto up to $500, APPROVAL above
  → zendesk.refund_confirmation (+ zendesk.gift_card_number) → slack.post_refund
  unclear or not-offered choice → zendesk.clarify_choice; already refunded / expired / wrong requester → note + Slack
```

The policy (`POLICY` in the workflow file, versioned and reviewed like code) is: cancel any live
subscription unless the Stripe product says `acme_cancellation=contract` (inside `acme_min_term_months`,
default 12) or `not_cancellable`, which need an approver; refund the last payment in full within 30 days to
any method, the unused share of the period as store credit or gift card within 90 days, nothing after that;
`acme_refundable=false` and `acme_refund_methods` on the product narrow it. Decisions and amounts are
computed in code; every customer-facing reply is a code-written template (it is posted without review), and
Zendesk emails public replies to the requester, so the whole conversation stays on the ticket.

What makes it safe to run unattended:

- The offer (methods, amount, payment, requester, policy version) is written to the Stripe subscription's
  metadata when it is cancelled. The refund stage trusts that record, not the trigger payload, and refuses
  a reply from anyone but the original requester, an expired offer or a method that wasn't offered.
- One refund per cancellation across runs: `acme_cxl_refund=pending:<run>` is written before money moves,
  `<method>:<ref>` after; a second reply or re-fired trigger gets "already refunded".
- Ticket comments carry a `ref CXL-…` marker and are looked up before posting, so a retry or a lost
  response never double-posts. Tags are added under Zendesk's `safe_update`.
- The full gift card number goes to the customer on the ticket only; run state keeps the last four digits.

Wire it up with two Zendesk triggers (webhook → your control plane → `POST /invocations start`):
ticket created with tag `cancellation` (or your cancellation form/IVR) → `{stage:"request", ticketId,
channel, customer, message, opsChannel, giftCardLocationId, approvers}`; requester comment on a ticket
tagged `cxl_refund_offer` → `{stage:"refund_choice", ticketId, customer, opsChannel, giftCardLocationId}`
(add `choice` when it comes from a ticket field). Use the ticket id in the `runId` (e.g. `zd-<id>-request`,
`zd-<id>-reply-<comment id>`) so re-delivered webhooks are deduplicated.

Relay proof (`node verify/relay-proof.mjs product-cancellation`, Stripe + Zendesk + Square + Slack twins,
one seeded Stripe customer per check): **21 executable checks held, 0 violated**, including all three refund
paths end to end, a refused second refund, exception approve/reject/stranger, the $500 approval gate,
duplicate and 4× concurrent triggers, four provider faults and a real restart. Six checks are declared
blocked where the twins can't exercise the behaviour yet (ticket creation and requester replies on the
Zendesk twin, backdated payments, store-credit and gift-card balance read-backs, Zendesk email delivery);
all but email delivery are covered by `test/product-cancellation.test.ts`.

## Deploy (one AgentCore runtime per workflow)

```bash
npx cdk deploy --all \
  -c looplabsAccountId=111122223333 -c looplabsExternalId=<shared-secret> \
  -c approvers:onboarding-kickoff=U_RVP -c approvers:revenue-reconciliation=U_CONTROLLER
# or one: npx cdk deploy AcmeOps-churn-risk-sweep   (one stack per workflow: AcmeOps-<workflow>)
# JWT instead of IAM: -c jwtDiscoveryUrl=https://idp.example.com/.well-known/openid-configuration -c jwtAllowedClients=looplabs
```

Each stack (`AcmeOps-<workflow>`, tagged `acme:org` / `acme:team` /
`acme:workflow`) creates an ARM64 AgentCore runtime, a DynamoDB state table, a
Secrets Manager secret and X-Ray tracing. If you pass `looplabsAccountId`, it
also creates a role LoopLabs assumes to call `InvokeAgentRuntime`. Put the
provider keys from [`.env.example`](.env.example) into each stack's `SecretArn`.

## Known gaps

- **Zendesk twin**: FetchSandbox doesn't have one yet. The Zendesk client
  ([`src/providers/zendesk.ts`](src/providers/zendesk.ts)) uses Zendesk's own
  REST v2 paths, so it will run against the twin once it exists (set
  `ZENDESK_BASE_URL`). Until then the Zendesk checks are declared blocked.
- **Not yet deployed to a live AWS account.** Verified with tests, `cdk synth`
  and the twin proofs. The Docker image wasn't built here.
