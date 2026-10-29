# FetchSandbox Playground

Open-source business operations workflows you can adopt, and the exercises we
use to test agent-built applications with [FetchSandbox](https://fetchsandbox.com).

**[Workflow catalog](docs/WORKFLOWS.md)** · **[Adopt a workflow](docs/ADOPTING.md)** · **[Verification guide](docs/VERIFICATION.md)** · **[What twins can't prove yet](docs/FETCHSANDBOX_GAPS.md)** · **[Contributing](CONTRIBUTING.md)**

## What's here

[`acme-ops`](acme-ops/README.md) holds **52 operations workflows** across
Finance, People, IT and Security, Legal and Privacy, RevOps, Supply Chain,
Support, Customer Experience, Sales and Quality.

Each one is a standalone Amazon Bedrock AgentCore runtime. Agents read your
systems in parallel, code makes the decisions, and every write is a named
action, gated by approval where it matters. Each workflow ships with:

- a **business guide**: the need, inputs, every write and approval, required
  credentials and provider setup ([docs/workflows/](docs/workflows));
- **local tests** against documented provider behaviour, with no network;
- an **executable verification contract** and a saved **FetchSandbox receipt**
  showing what was proven on provider twins and what wasn't;
- a **CDK stack** for AWS (state in DynamoDB, secrets in Secrets Manager,
  scheduled timers).

A few examples:

| Area | Workflows |
|---|---|
| Finance | supplier bank-change verification, invoice three-way match, month-end close, purchase request → PO, treasury payment dual control, failed-payment dunning, usage true-up, duplicate-charge remediation |
| People | employee offboarding with final pay, payroll anomaly review, work-authorization and leave dates |
| IT and Security | SOC 2 user access review, change management gate, vulnerability remediation SLA, account-takeover containment, joiner/mover/leaver |
| Legal and Privacy | contract intake and e-signature, DSAR export, consent propagation, GDPR/CCPA erasure, partner sanctions re-screen |
| Revenue and Support | lead routing with SLA, CRM ↔ billing sync, support first-response SLA, AI support triage, cross-border refunds |
| Operations and supply chain | order-to-cash, inventory replenishment, delivery exceptions, supplier non-conformance, field-service dispatch |

Built for production-grade operations:

- **Durable:** state survives restarts, and timers run for weeks.
- **Idempotent:** duplicate triggers and retries never repeat an effect.
- **Fail-closed:** an unreadable system blocks the decision, not the audit.
- **Controlled:** segregation of duties on approvals.
- **Traceable:** a hash-chained audit trail.

Every provider client follows the vendor's published API, and versions are
pinned ([audit](docs/PROVIDER_SPEC_AUDIT.md)).

## Adopt a workflow in five steps

```bash
git clone https://github.com/fetchsandbox/playground.git
cd playground/acme-ops
npm ci && npm run check && npm test && npm run bundle
cp .env.example .env            # set only the providers your workflow's guide lists
WORKFLOW=dsar-export STATE_FILE=.state/dsar-export.json node --env-file=.env dist/main.mjs
curl -s localhost:8080/invocations -d '{"action":"describe"}'
```

1. **Pick** a workflow in the [catalog](docs/WORKFLOWS.md) and read its guide.
2. **Connect** sandbox accounts for the providers it lists, and do its provider
   setup.
3. **Run** it locally and drive it through `POST /invocations`.
4. **Adapt** its `POLICY` and approvers to your company, and keep the tests
   green.
5. **Deploy** with `npx cdk deploy AcmeOps-<workflow>`, and **verify**
   against twins and your own sandboxes.

[docs/ADOPTING.md](docs/ADOPTING.md) walks through each step: the control
commands, signals and timers, triggers, AWS deployment, and operations.

> The policies are examples for a fictional company (Acme). Review them with
> your own finance, legal, security or HR owners. Nothing here has been run
> against a live AWS account by this project, and twin proofs don't certify
> live delivery.

## Other collections

| Collection | Business/use case | Stack and availability |
|---|---|---|
| [Customer Operations](docs/workflows/customer-operations.md) | Account research, quote, billing, survey and approved dispatch | TypeScript; code on `main`; no package-specific FetchSandbox proof runner on `main` |
| [Quote, customer handoff and refund examples](docs/WORKFLOWS.md#separate-branch-examples) | Commercial approvals, onboarding handoffs and evidence-based refunds | Separate branches/PRs; not bundled into `main` |
| [Small provider apps](docs/WORKFLOWS.md#small-integration-apps-and-planted-bug-exercises) | Focused integrations, including planted-bug and greenfield exercises | Mostly Python; read each app's README |
| [Invoice Watch](invoice-watch/README.md) | Subscription-invoice bot | BDK; separate build/eval loop |
| [20-minute integration exercise](TESTING.md) | Try FetchSandbox on a small app | Python |

## Verification is part of development

Connect the [FetchSandbox MCP](https://fetchsandbox.com/mcp) in your coding client and follow its current authentication and setup instructions. The root `.mcp.json` and `.cursor/mcp.json` declare a key-free MCP server; approve workspace trust and authenticate in your client as needed. Root [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md) and the Cursor always-on rule guide supported coding agents through app-owned contracts and measured proof. They don't install a connector, grant credentials or instrument deployed runtime agents.

A useful request to your coding agent:

> Read this workflow's business guide and implementation. Establish its FetchSandbox contract within the app's actual scope. Verify it against isolated twins, investigate failures, fix narrowly, and report the receipt, saved-state evidence, versions and remaining blockers.

For Acme workflows, the existing runner is:

```bash
cd acme-ops
node verify/relay-proof.mjs dsar-export
```

This requires FetchSandbox authentication and managed-relay access, and it uses network resources. A checked-in receipt is historical: it doesn't prove your changed code. Keep local tests, twin proof, cloud deployment, native triggers and real customer delivery separate. Read [the verification guide](docs/VERIFICATION.md) before claiming a result, and [FETCHSANDBOX_GAPS.md](docs/FETCHSANDBOX_GAPS.md) for what twins can't prove yet.

## Repository map

| Path | What it holds |
|---|---|
| [`acme-ops/src/workflows/`](acme-ops/src/workflows) | One file per workflow: business rules, `POLICY`, agents, actions |
| [`acme-ops/src/kit/`](acme-ops/src/kit) | Engine (durable runs, approvals, signals, timers, compensation, audit), AgentCore server, HTTP client |
| [`acme-ops/src/providers/`](acme-ops/src/providers) | Vendor API clients (Stripe, HubSpot, Zendesk, NetSuite, Gusto, GitHub and more) |
| [`acme-ops/test/`](acme-ops/test) | Local tests and the documented-behaviour provider fake |
| [`acme-ops/verify/`](acme-ops/verify) | FetchSandbox contracts, receipts and the proof runner |
| [`acme-ops/infra/`](acme-ops/infra) | CDK: one AgentCore stack per workflow |
| [`docs/`](docs) | Catalog, generated business guides, adoption, verification, gap and audit reports |

## Contribute

Fixes, new workflows and honest failed results are all welcome. Read
[CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).
Report security problems privately ([SECURITY.md](SECURITY.md)).

Before opening a pull request:

```bash
cd acme-ops && npm run check && npm test && cd ..
python3 scripts/workflow_docs.py --check
python3 scripts/check_doc_links.py
```

## License

[MIT](LICENSE). Fork and adapt freely. The demo policies and synthetic data
aren't production certification or your company's approved operating policy.
