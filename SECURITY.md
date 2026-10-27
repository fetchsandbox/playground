# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately
through GitHub instead: on this repository's **Security** tab, choose
**Report a vulnerability**. Include:

- the affected workflow, kit module or provider client, with the file and
  commit;
- what an attacker can do, and the steps or a minimal example to reproduce it;
- any suggested fix.

We aim to acknowledge reports within five business days and to keep you
informed until the issue is resolved. Please give us a reasonable time to fix
it before disclosing it publicly.

## In scope

- The workflow runtimes in `acme-ops/src/`, including:
  - authorization of approvals and signals (who may approve or decide);
  - idempotency and effect claims (double payments, double refunds, duplicate
    writes);
  - prompt injection through customer text that reaches a model or a
    customer-facing write;
  - leaking credentials, tokens or personal data into logs, run state,
    receipts or Slack.
- The verifier endpoint (`/verify/...`), which exists only when
  `FETCHSANDBOX_VERIFIER_TOKEN` is set.
- The deployment templates in `acme-ops/infra/`.

## Out of scope

- The example policies (limits, thresholds, deadlines). They are
  demonstrations, not recommendations for your company.
- Vulnerabilities in the providers themselves (Stripe, HubSpot and others).
  Report those to the vendor.
- FetchSandbox's hosted service. Report those through
  [fetchsandbox.com](https://fetchsandbox.com).

## Handling secrets

Never commit credentials, tokens, `.env` files or real customer data. If you
find a committed secret, report it privately as above. Then rotate it with the
issuing provider: removing it from Git history alone doesn't make it safe.
