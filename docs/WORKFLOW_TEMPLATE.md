# New workflow documentation requirements

A workflow is an executable business example, not just a list of connectors.
Provide these items before advertising it as reusable:

1. Business problem, intended user and expected customer/operator outcome.
2. Organization, department, responsible team and configurable individual owner.
3. Trigger and actual intake adapter; sample input using synthetic identities.
4. Each agent's responsibility, tools/read access, outputs and handoff to writers.
5. Policy source/version, numeric boundaries and automatic/approval/decline paths.
6. Possible writes, authorized recipient/tenant and customer-visible communication.
7. Local setup, credential scopes, private configuration, fixture preparation and cleanup.
8. Existing deployment instructions with runtime/storage assumptions and cost boundaries.
9. FetchSandbox contract/check IDs, saved-state assertions and runnable commands.
10. Evidence with exact app/contract version and all blocked, skipped or unmeasured cases.
11. Recovery/retry/restart and reconciliation behavior, distinguishing design from measurement.
12. Known limitations, production requirements and code/test/receipt links.

Keep live account IDs, tokens, private logs and customer content out of examples.
Use `example.test` identities. Do not publish a demo as production-certified.
Update the catalog, coding-agent discovery instructions where needed, and docs
checks. For Acme definitions, update scripts/workflow_docs.py and regenerate:

```bash
python3 scripts/workflow_docs.py
python3 scripts/workflow_docs.py --check
python3 scripts/check_doc_links.py
```
