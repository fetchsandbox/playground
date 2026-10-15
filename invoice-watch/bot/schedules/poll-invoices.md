---
cron: "0 */4 * * *"
---

Scan Gmail for new subscription invoice, renewal, or receipt emails from
the last 7 days. For each new hit, follow the process-subscription-invoice
skill: create a Google Calendar cancel reminder and post a Slack alert.
Skip invoices already recorded via check_invoice_processed. Summarize
processed, skipped-duplicate, and ignored counts. If Gmail tools are
unavailable, report that and stop without inventing mail.
