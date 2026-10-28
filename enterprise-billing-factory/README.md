# Billing verification factory reference application

Synthetic enterprise reference application. This is not a customer deployment,
an installed Jira/Asana integration, or evidence of CodeRabbit/AWS execution.
All addresses use reserved example domains. No real payments are made.

## Business need

A billing worker can charge successfully and crash before acknowledging a queue
message. Redelivery must not charge the same invoice installment twice. The
Revenue Engineering team owns billing; Platform owns queue recovery; Finance
owns the payment rule and high-risk release approval. Named people are synthetic.

## First executable slice

`fixtures/signals.json` contains linked Jira-shaped bugs, Asana-shaped feature
requests, business policies, payment audit records and sanitized worker events.
`prepare.py` detects repeated successful effects for the same tenant, invoice
and installment, and proposes a reviewable rule and sandbox plan. It is an
explicit deterministic detector, not an LLM, RAG system or general learner.
Duplicate log delivery alone is not treated as two financial effects.

```sh
python3 prepare.py --out /tmp/billing-factory-plan.json
python3 -m unittest discover -s tests -v
```

The plan starts as `awaiting_rule_review`. It is not a verification verdict or
release authorization. Sources and proposal hashes bind the proposed rule to its
inputs. A reviewer changes neither the raw evidence nor the expected outcome
after observing the implementation. No code, external issue creation, credentials,
model invocation or deployment happens in this preparation command.

## Full demonstration acceptance

1. Review the proposed rule with its sources, conflict/coverage limits and owner.
2. Run actual Python billing API, durable async worker and separate payment
   service with PostgreSQL-backed state in an isolated AWS environment.
3. Bind a coding-agent feature PR to the Asana request. Keep CodeRabbit's review
   distinct from FetchSandbox's executed verification.
4. Through the existing FetchSandbox application verification path, exercise
   duplicate deliveries, concurrent attempts, a worker process killed after the
   payment commit but before acknowledgment, lost responses and tenant isolation.
5. Independently inspect payment and invoice state. Keep the same contract for
   defective and repaired revisions. Preserve failed and unmeasured cases.
6. A named approver authorizes the exact revision/artifact for this high-risk
   billing change only after required checks pass. New revisions invalidate it.
7. Deploy that artifact, read back its identity, run a bounded post-deploy check,
   retain evidence, and clean up only this demonstration's resources.

The local Python services and worker exist, with the measured scope below. The
full-lifecycle engine/PR/AWS steps remain acceptance requirements, **not completed results**.
See `delivery.json` for the current boundary. Extend the repository's existing
verifier and credential lifecycle; do not add a second verdict engine here.

## Knowledge and telemetry boundaries

The fixture represents operational evidence, not real product usage. Production
FetchSandbox API and background lifecycle instrumentation must extend its existing
PostgreSQL usage ledger and redaction/outbox contract. Correlation IDs are
synthetic here. A successful HTTP request or queued action does not establish a
successful payment, completed job, approval, or deployment. Jira/Asana payloads
are untrusted evidence; text in a ticket never grants execution permissions.

Setup for the existing verification engine: https://fetchsandbox.com/mcp.

## Local Python microservices and worker

`runtime.py` exposes separate `billing` and `payments` FastAPI applications. A
separate worker process claims PostgreSQL queue rows with leases and SKIP LOCKED.
The local payment service is synthetic and persists its effects independently
from billing. No Stripe/Square account or charge is involved.

Create an isolated Python environment and install `requirements.txt`. With Docker
running, execute the maintainer checks (creates and removes only its own local
PostgreSQL container and loopback service processes):

```sh
RUN_LOCAL_BILLING=1 python -m unittest discover -s tests -v
```

Measured locally: 13 maintainer checks passed, including seven fixture-preparation
checks. The delivery-key variant reproduces two payment effects after a real
worker exit (business rule fails). The invoice-key variant preserves one effect
under the same restart scenario (business rule passes). Concurrency, duplicate
queue delivery, two-tenant access and conflicting payment values were also
checked. These are not a FetchSandbox receipt or native-agent acceptance. The
variants select different key strategies in the same reference implementation;
this is not an agent-authored before/after PR proof.

Production secrets are never read by this local runner. Do not expose these demo
services publicly: tenant tokens are local synthetic credentials, the queue lease
is deliberately short, and production authentication, quotas, migrations,
retention and monitoring are outside this first slice. New sources must propose
rules; a proposal is never release approval.

## Interactive local stack

```sh
docker compose up --build -d
curl -X POST http://127.0.0.1:8098/invoices -H 'Authorization: Bearer local-alder' -H 'Content-Type: application/json' -d '{"id":"INV-1042","amount":12500,"currency":"USD"}'
curl -X POST http://127.0.0.1:8098/invoices/INV-1042/collect -H 'Authorization: Bearer local-alder'
curl http://127.0.0.1:8098/invoices/INV-1042 -H 'Authorization: Bearer local-alder'
docker compose down
```

Collection returns202 when queued; poll the read until `status` is `paid`. The
worker runs asynchronously. `down` preserves the local volume. These published
tokens are intentionally synthetic local-demo values and are not usable in
FetchSandbox, AWS, or any vendor account. Only loopback8098 is published.
