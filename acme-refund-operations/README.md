# Acme Refund Eligibility and Resolution

A separate AWS AgentCore workflow for Acme Corporation's Customer Service and Revenue Operations department. Owner: Raj. Owning team: Refund Assurance. On-call: rnagulapalle. Environment metadata: production; **synthetic demo with Stripe test-mode only**, not Acme/Reliant production policies or live refunds.

Six specialist components hand work through durable cases: intake → purchase research → product/return evidence → policy research → billing authorization/execution → customer handoff. Policy research can use Claude to summarize retrieved clauses; it cannot authorize money movement. The other components use explicit provider operations and deterministic checks. These are not six independent autonomous LLMs.

## Policies and evidence

`policies/catalog.json` contains the demo product catalog, company policy, per-product terms and cited clause IDs. These terms are deliberately invented for the demo: hardware return windows/inspection, software usage limits and non-refundable completed service. Enterprise purchase/return documentation informed the evidence pattern, not the numeric terms. See [Cisco's returns FAQ](https://www.cisco.com/c/en/us/support/returns/faq.html) and [Stripe's refund API](https://docs.stripe.com/api/refunds/create).

CDK creates a private, versioned S3 bucket. An operator uploads `catalog.json` and trusted merchant `orders/<payment_intent>.json` return/usage evidence. The runtime has read-only S3 access, cannot change policy, records S3 version IDs and content hashes, and rereads evidence when an approval is used. Customer text is not merchant return evidence. The payment's Stripe metadata `acme_sku` selects a product policy; the payment customer must match the requesting email. HubSpot provides additional CRM context, not payment ownership authority.

Eligibility precedes authorization:

- Eligible and below 20% of the original paid amount: automatic.
- Eligible and 20% through 70%: configured manager approval, valid for 24 hours when acted on.
- Above 70%, or cumulative refunds above 70%: decline.
- Missing/conflicting product or merchant evidence: hold; never assume eligibility.
- Disputed, unpaid, outside-window or excluded-product purchases: no refund.

A pending case binds its purchase, percentage and evidence snapshot. The app rereads Stripe and policy/order evidence immediately before execution. Changed evidence invalidates prior approval. A stable Stripe idempotency key and saved operation intent reconcile uncertain responses. DynamoDB serializes cases and payment actions. Uncertain email delivery is held instead of blindly resent. Pending refunds are described as pending, not successful.

## Triggering

After the native delivery route is connected, in the **Acme Enterprise** Slack app send:

```
Please refund pi_YOUR_TEST_PAYMENT 20%
```

The test payment must belong to the email in your Slack profile. The workflow posts progress and, when eligible, approval buttons in that thread. Only configured manager `U0AHZ0RCM` may approve/reject; this demo permits Raj to request and approve. A 75% request is declined. Approval does not bypass product eligibility.

Email: send to **operations@fetchsandbox.com**, with a subject containing **Acme refund**, and include `refund pi_YOUR_TEST_PAYMENT 20%` in the plain-text body. Only that recipient/subject scope is read by refund intake. Notifications reply through Gmail as Acme Refund Operations, using the existing business sender and original thread when available. Gmail self-forwarded messages may be deduplicated; use another mailbox for an external customer test.

IAM-authenticated AgentCore `/invocations` commands:

```json
{"action":"describe"}
{"action":"policies"}
{"action":"start","input":{"caseId":"DEMO-001","customerEmail":"your-test-customer@example.com","paymentIntent":"pi_YOUR_TEST_PAYMENT","requestedPct":20,"channel":"api"}}
{"action":"status","caseId":"DEMO-001"}
{"action":"decide","caseId":"DEMO-001","decision":"approve","userId":"U0AHZ0RCM"}
{"action":"resume","caseId":"DEMO-001"}
```

The internal delivery worker authenticates Slack before submitting decisions. An IAM invoker is a trusted internal operator; `userId` alone is not a public authentication mechanism. No public decision endpoint is exposed. No LoopLabs dependency, execution role or enforcement adapter is added.

`describe` publishes organization, owner, deployment version, six components, policy source/version, product list and controls. AWS tags/environment expose ownership and policy catalog location. This makes metadata available; it does not prove another control plane imports or enforces it.

## Deployment and retention

From `../acme-ops`, use the existing CDK tooling:

```
AWS_PROFILE=fetchsandbox AWS_REGION=us-west-2 npx cdk deploy AcmeRefundOperations --app 'npx tsx infra/refund-app.ts' --require-approval never -c sourceCommit=<full-commit>
```

Populate the separate Secrets Manager secret with existing Stripe **test** credentials, HubSpot, Slack, Google OAuth and optional Anthropic configuration before first invocation. No credentials are committed. No live-mode Stripe payment is accepted. Existing quote/workflow runtimes are separate resources.

DynamoDB case retention is 30 days with asynchronous TTL removal; CloudWatch runtime/delivery logs are 14 days; delivery failures retain 14 days. S3 policy/evidence versions are retained for reproducibility and require explicit operator lifecycle management. Do not upload personal production documents for this demo.

Safe structured events are independently saved with run/case/event/action IDs, attempts, trace/span IDs and deployment version. Explicit ADOT spans contain operation names and identifiers, not raw HTTP/model/customer bodies. Full case state is available only through IAM. Provider references and summaries support readback.

## Tests and limits

```
cd acme-refund-operations
python -m pytest tests -q
```

Unit tests use clearly marked provider doubles. They establish deterministic branching/recovery logic, not AWS or provider delivery. The existing published FetchSandbox MCP runner is:

```
cd acme-ops
PROOF_PORT=8158 node verify/relay-proof.mjs refund-operations
```

Its six executable checks use real twin HTTP calls and independent refund/email readback. Advanced crash/fault/concurrency and policy drift are explicitly unmeasured in that MCP contract; unit tests do not substitute for those receipts. Local-only fixture/observation routes require `ACME_LOCAL_VERIFY=true` and a verifier token; they are absent from the deployed runtime.

No automatic external policy/RMA ingestion, actual stock mutation, bank-settlement guarantee, approval-expiry sweep or generic helpdesk ticket trigger is claimed. Eligibility return/usage records are explicit merchant fixtures, never fabricated as a customer claim. Deployment and native acceptance evidence are recorded separately from this source document.
