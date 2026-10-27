# Contributing

Thanks for helping. This repository is a set of open-source business workflows,
each verified against provider twins with [FetchSandbox](https://fetchsandbox.com).
Contributions of every size are welcome. Examples:

- fixing a guide;
- reporting a provider call that doesn't match the vendor's docs;
- proposing a new workflow;
- recording an honest failed proof.

## Ways to contribute

| You want to | Start with |
|---|---|
| Report a bug in a workflow or the kit | A [bug report](https://github.com/fetchsandbox/playground/issues/new?template=bug_report.yml) |
| Propose a new business workflow | A [workflow proposal](https://github.com/fetchsandbox/playground/issues/new?template=workflow_proposal.yml) |
| Report something FetchSandbox can't prove | A [FetchSandbox gap](https://github.com/fetchsandbox/playground/issues/new?template=fetchsandbox_gap.yml) |
| Fix docs or code | A pull request (see below) |
| Report a security problem | [SECURITY.md](SECURITY.md); don't open a public issue |

## Development setup

You need Node.js 22 or later, npm and Python 3.

```bash
git clone https://github.com/fetchsandbox/playground.git
cd playground/acme-ops
npm ci
npm run check      # TypeScript
npm test           # local tests against documented provider behaviour; no network
npm run bundle
cd ..
python3 scripts/workflow_docs.py --check   # generated guides are current
python3 scripts/check_doc_links.py         # every local link resolves
```

CI runs the same commands on every pull request.

## Ground rules

These keep the workflows trustworthy for the people who adopt them.

1. **Follow the vendor's API, not a test double.** Every provider call must
   match the vendor's published API reference: paths, parameters, auth,
   response fields, pagination, versions. Never shape a client around a twin
   or a fake. If a twin answers differently, record it as a gap. See
   [docs/PROVIDER_SPEC_AUDIT.md](docs/PROVIDER_SPEC_AUDIT.md).
2. **Keep decisions in code and writes behind gates.** Agents read; actions
   write, each with a gate. Models draft words; code decides money, access and
   recipients. Customer mail is drafted, not sent.
3. **Keep the safety properties.** Idempotency keys, write-time re-checks,
   segregation of duties, fail-closed reads and audit trails don't come out
   without an explicit, reviewed reason.
4. **Report results honestly.** Don't delete or weaken a check to get a
   passing receipt. A failed or unmeasured check, with its cause, is a useful
   contribution. A checked-in receipt is historical evidence for its recorded
   version only.
5. **No secrets or real customer data.** Use placeholders in examples and
   synthetic data in fixtures. Credentials go in your private `.env`, never in
   the repository or a receipt.

## Changing a workflow

1. Read its guide in [docs/workflows/](docs/workflows) and its source in
   [acme-ops/src/workflows/](acme-ops/src/workflows).
2. Make a narrow change and update `acme-ops/test/<workflow>.test.ts`.
3. If behaviour changes, update `acme-ops/verify/contracts/<workflow>.mjs`.
   Keep existing check ids, and say in the PR what changed in the contract.
4. Regenerate guides with `python3 scripts/workflow_docs.py`. Don't edit
   generated guides by hand.
5. If you have FetchSandbox access, run
   `node acme-ops/verify/relay-proof.mjs <workflow>` from `acme-ops/` and
   commit the new receipt. Otherwise say it wasn't run.

## Adding a workflow

1. Open a workflow proposal first, so the business rules and approval
   boundaries can be discussed before code.
2. Follow [docs/WORKFLOW_TEMPLATE.md](docs/WORKFLOW_TEMPLATE.md) and the kit
   primitives in [docs/ADOPTING.md](docs/ADOPTING.md#build-your-own-workflow).
3. Add, in one PR:
   - `src/workflows/<id>.ts`
   - `test/<id>.test.ts`
   - `verify/contracts/<id>.mjs`
   - a business-need line in `scripts/workflow_docs.py`
   - a catalog row in `docs/WORKFLOWS.md`
   - the generated guide
4. Fakes in `test/fake-world.ts` must follow the vendor's documented
   behaviour, not a twin's.

## Pull requests

Fill in the [pull request template](.github/pull_request_template.md):

- the business behaviour that changes;
- the verification you ran, with counts, including failures and unmeasured
  checks;
- the remaining limits.

Documentation-only changes need the docs and link checks, not a new proof.
Say so in the PR.

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
