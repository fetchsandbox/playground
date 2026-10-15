---
cron: "0 */4 * * *"
---

Use search_gmail_invoices (official Gmail MCP search_threads) for the
last 7 days. For each promising hit, get_gmail_message, then follow
process-subscription-invoice: create_cancel_calendar_event and
post_slack_invoice_alert. Skip invoices already recorded via
check_invoice_processed. Summarize processed, skipped-duplicate, and
ignored counts. If the Gmail MCP connection is unauthorized, report that
and stop without inventing mail.
