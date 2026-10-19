# FetchSandbox Playground

Open-source integration exercises and Acme business workflows for testing agent-built applications with [FetchSandbox](https://fetchsandbox.com).

**[Browse the business workflow catalog](docs/WORKFLOWS.md)** · **[Verification guide](docs/VERIFICATION.md)** · **[20-minute integration exercise](TESTING.md)**

## Choose what you want to build or verify

| Collection | Business/use case | Stack and availability |
|---|---|---|
| [Acme Operations](acme-ops/README.md) | Twenty workflows across Support, Customer Experience, Sales, Finance, IT, Quality and other departments | TypeScript; independent AgentCore runtimes; code on `main` |
| [Customer Operations](docs/workflows/customer-operations.md) | Account research, quote, billing, survey and approved dispatch | TypeScript; code on `main`; no package-specific FetchSandbox proof runner on `main` |
| [Quote, customer handoff and refund examples](docs/WORKFLOWS.md#separate-branch-examples) | Commercial approvals, onboarding handoffs and evidence-based refunds | Separate branches/PRs; not bundled into `main` |
| [Small provider apps](docs/WORKFLOWS.md#small-integration-apps-and-planted-bug-exercises) | Focused integrations, including planted-bug and greenfield exercises | Mostly Python; read each app's README |
| [Invoice Watch](invoice-watch/README.md) | Subscription-invoice bot | BDK; separate build/eval loop |

These collections are not all planted-bug apps and are not all 50–150-line Python examples. Some are substantial multi-agent workflows. Read the selected business guide for its actual behavior and limitations.

## Start locally

```bash
git clone https://github.com/fetchsandbox/playground.git
cd playground
```

Pick a guide from the catalog and follow its package setup. Use your own private test credentials and synthetic data. Cloud deployment and live-provider access are optional, separate steps; cloning the repo grants no access to the hosted Acme demo.

For example, prepare the Acme package:

```bash
cd acme-ops
npm ci
npm run check
npm test
npm run bundle
```

## Verification is part of development

Connect the [FetchSandbox MCP](https://fetchsandbox.com/mcp) in your coding client and follow its current authentication/setup instructions. The root `.mcp.json` and `.cursor/mcp.json` declare a key-free MCP server (pinned to `0.7.29`); approve workspace trust and authenticate in your client as needed. Root [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md) and the Cursor always-on rule guide supported coding agents through app-owned contracts and measured proof. They do not install a connector, grant credentials, force every client to read instructions or instrument deployed runtime agents.

A useful request to your coding agent:

> Read this workflow's business guide and implementation. Establish its FetchSandbox contract within the app's actual scope. Verify it against isolated twins, investigate failures, fix narrowly, and report the receipt, saved-state evidence, versions and remaining blockers.

For Acme workflows, the existing runner is:

```bash
cd acme-ops
node verify/relay-proof.mjs support-escalation
```

This requires FetchSandbox authentication and managed-relay access and uses network resources. A checked-in receipt is historical: it does not prove your changed code. Keep local tests, twin proof, cloud deployment, native triggers and real customer delivery separate. Read [the verification guide](docs/VERIFICATION.md) before claiming a result.

## Contribute

Fork the repo and open a PR with the business need, source changes, relevant contract, sanitized evidence/receipt and explicit limits. For an exercise, use [FINDINGS_TEMPLATE.md](FINDINGS_TEMPLATE.md). For a new business workflow, use [the workflow documentation requirements](docs/WORKFLOW_TEMPLATE.md). Honest failed or blocked results are useful; do not remove cases to obtain a passing summary.

Documentation checks:

```bash
python3 scripts/workflow_docs.py --check
python3 scripts/check_doc_links.py
```

## License

[MIT](LICENSE). Fork and adapt the examples. Demo policies and synthetic data are not production certification or your company's approved operating policy.
