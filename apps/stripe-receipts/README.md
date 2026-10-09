# Stripe order and Resend receipt playground

Adapted from `apps/stripe` at commit 9d33904e78ef1148553eac17432eaf8b81fb39ba.
A payment event marks an order paid and sends a receipt through Resend.
This is a deliberately unverified brownfield fixture, not a production template.

Start: `uvicorn main:app --port 8080`.
Configure `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_API_BASE`,
`RESEND_API_KEY`, `RESEND_API_BASE`, `RESEND_FROM` with isolated test values.
Do not use live payments or deliver email to real customers during this demo.

Try asking your MCP-enabled coding agent:

> Our checkout uses Stripe and sends receipts through Resend. Investigate the app, fix the bugs you find, and prove the fixes against the running code before our QA team uses it. Show what passed, failed, and remains unverified.

A provider-only workflow does not prove this app. Findings and proposed diffs are not measured proof. Preserve the buggy code until the same scenario has run against both versions.
