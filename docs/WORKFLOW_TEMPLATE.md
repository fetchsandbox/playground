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
13. Builder journey and acceptance: one user request -> actual builder agent ->
    MCP behavioral contract (happy path, customer rules, applicable default risks)
    -> protected twins -> FetchSandbox-driven runtime execution -> independent
    effects -> retained receipt. Name the contract/execution owners, authenticated
    repeatable trigger, same-job polling and exact builder-client evidence. Mark
    manual webhook arming or scripted-only runs as partial setup/component proof,
    not a delivered builder integration. Include this as the first planning
    milestone and final acceptance gate, not a follow-up after component work.

Keep live account IDs, tokens, private logs and customer content out of examples.
Use `example.test` identities. Do not publish a demo as production-certified.
Update the catalog, coding-agent discovery instructions where needed, and docs
checks. For Acme definitions, update scripts/workflow_docs.py and regenerate:

```bash
python3 scripts/workflow_docs.py
python3 scripts/workflow_docs.py --check
python3 scripts/check_doc_links.py
```
