# Commerce SDK shopper-message recovery reference

Local integration reference owned by FetchSandbox engineering, with Raj as demo
owner. This is a proposed Agentcard/OpenCommerce pilot, not a customer endorsement
or a reported defect in their SDK. No live purchases, cards, charges or external
customer messages are available in this application.

## Business purpose

A shopper should receive the correct purchase update once even when a webhook is
redelivered, multiple application servers receive it, or a server stops during
delivery. A successful webhook acknowledgment must not silently discard work.

The application uses the unmodified published `@agent-cards/commerce-sdk@0.18.5`
`agentcardWebhook` handler for signature verification, parsing, expiry filtering
and per-process deduplication. The SDK's documented cross-server responsibility
belongs to the integrating application. It does not supply this demo's inbox,
outbox, recipient bindings or downstream idempotency.

There are no LLM agents in this first slice. Two actual Node application workers
receive signed synthetic purchase-message events. PostgreSQL stores the inbox
and outbox. A separate captured-message HTTP sink has its own database/role. The
external controller reads database state directly; candidate success claims never
set a verdict. These roles are processes, not advertised agent counts.

## Delivery rule and repair

`src/delivery-naive.mjs` is an intentionally defective reference implementation:
it acknowledges a volatile callback and relies on process-local SDK memory.
`src/delivery.mjs` atomically records the event and pending notification, rejects
conflicting event identities, and drains the outbox with PostgreSQL row locks.
The sink deduplicates stable notification IDs. That last requirement is explicit:
an outbox alone cannot promise exactly one visible message from an arbitrary
email/chat API if a successful send's response is lost.

Configured shopper/provider-user/thread bindings are synthetic administrative
fixtures. They are not live Agentcard identity or OAuth acceptance. Expired and
badly signed messages produce no notification. Test event bodies are derived
from the pinned public contract, not captured live-provider payloads.

## Setup and execution

Requires Python 3, Node 22, npm and a disposable local Docker daemon. The public
scenario runner does not require a FetchSandbox account or private repository.
Install only locked dependencies:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

The maintainer proof used a separate pilot Docker daemon. On your workstation,
select your own disposable local daemon with `DOCKER_HOST` and explicitly pass
`--allow-local-demo-host`. Never select a production host or the daemon running
your production application. No provider credentials are needed.

Build the two application artifacts on that daemon:

```sh
# Linux example. For Docker Desktop/Colima, use your local context's socket:
# docker context inspect --format '{{.Endpoints.docker.Host}}'
export DOCKER_HOST=unix:///var/run/docker.sock
docker build -t fs-opencommerce:fixed --build-arg DELIVERY=delivery.mjs .
docker build -t fs-opencommerce:broken --build-arg DELIVERY=delivery-naive.mjs .
python3 verify/run.py --out /tmp/opencommerce-proof-unique \
  --fixed-image fs-opencommerce:fixed --broken-image fs-opencommerce:broken \
  --allow-local-demo-host
```

Use a new evidence directory each time. The controller creates a private internal
network and disposable PostgreSQL, sink, observer and application containers for
each leg, then removes only those resources. Application containers have no host
mounts, published ports, production secrets or provider API client. Runtime uses
a read-only root, dropped capabilities, no-new-privileges and resource limits.
Builds download pinned npm dependencies; this is a maintainer-built reference,
not a certification of isolation against hostile PRs. Images/cache remain for
reproduction and can be removed separately by their recorded IDs.

## Checks and proof interpretation

[The frozen contract](verify/contract.json) names every scenario and limitation.
The same controller, contract and SDK run against healthy, deliberately defective
and repaired artifacts. The optional maintainer comparison imports the existing
FetchSandbox `verification_factory.comparison` and `app.flows.proof_gate`; the
private product engine is not copied into this public example. Receipts record actual image IDs, source revision,
assertion/contract hashes, observed database effects, crash status and cleanup.

Without `--engine-root`, exit 0 means the ordinary application matrix completed
with healthy/repaired checks passing and a failing negative control. The emitted
`comparison.json` explicitly says the FetchSandbox comparison was not executed.
With an authorized maintainer engine checkout, add `--engine-root /path/to/sandbox`
to execute that existing gate. That mode's exit 0 means the scoped comparison
passed. Exit 2 means setup, incomplete evidence or failed comparison. Individual
leg receipts distinguish observed behavior failure (1) from setup failure (2).
Never count missing cases or interrupted execution as passing.

Read the [saved results](evidence/RESULTS.md) before interpreting a receipt.
Maintainers with the private engine checkout can check receipts in a fresh process
and exercise malformed-evidence rejection through the same existing gate:

```sh
python3 verify/check-evidence.py --evidence /tmp/opencommerce-proof-unique \
  --engine-root /path/to/verification-factory/sandbox
```

These local JSON records are editable operator evidence, not cryptographically
authenticated attestations. Receipt-shape rejection does not establish resistance
to an operator who rewrites the observations and hashes together.

## Telemetry and access boundary

The inbox/outbox, sink attempts and controller receipts are local business
lifecycle evidence, not a second FetchSandbox analytics service. They contain
synthetic identifiers only. No real account attribution is claimed. The webhook
caller is signature-verified under a synthetic secret; a payload shopper is not
the authenticated FetchSandbox caller. Failure bodies and private credentials
are not published as usage records. Production API/MCP exposure would require
the existing [usage telemetry contract](https://github.com/rnagulapalle/sandbox/blob/main/docs/development/usage-telemetry.md),
including account/provider attribution, redaction, durable failures and replay.

## What this does not establish

No Agentcard sandbox/API connection, real inbox delivery, merchant purchase,
charge, settlement, approval/price-change correctness, automatic PR check,
deployment, or native-agent acceptance is implied. Connect FetchSandbox through
the [maintained MCP setup](https://fetchsandbox.com/mcp) for supported production
verification paths. This local adapter does not register a new Agentcard provider
or automatically create a hosted receipt. Adding a cloud receipt or native-agent
run must use the existing runner and disposable credential lifecycle; unsupported
provider setup must remain visible.

## Primary integration contracts

- [SDK quickstart and sandbox boundary](https://docs.agentcard.com/commerce-sdk/quickstart)
- [Webhook signatures, retry and process-local deduplication](https://docs.agentcard.com/api-reference/commerce-sdk/webhook-handler)
- [Listener restart/cursor behavior](https://docs.agentcard.com/api-reference/commerce-sdk/listen)

The SDK remains proprietary under its published license; it is installed as a
dependency and is not copied into this repository. Demo source and docs do not
authorize accepting provider terms, creating credentials or using live payments.
