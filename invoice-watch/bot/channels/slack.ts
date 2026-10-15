import { slackChannel } from "@cursor/bdk/channels/slack";

/**
 * Inbound Slack wake channel + credentials for outbound
 * chat.postMessage via ctx.host.slack.getClient() (@slack/web-api).
 * Missing tokens mount idle — run:
 * `npx @cursor/bdk slack create --dir . --name "Invoice Watch"`
 */
export default slackChannel({
  envPrefix: "INVOICE_WATCH",
  suggestedPromptsTitle: "Try asking",
  suggestedPrompts: [
    {
      title: "Process pasted invoice",
      message:
        "Process this subscription invoice with real Calendar create_event + Slack chat.postMessage tools. Channel: C0123456789.\n\nFrom: billing@notion.so\nSubject: Your Notion invoice for $29.00\nBody: Invoice INV-1001. Next renewal 2026-11-15. Cancel anytime before renewal.",
    },
    {
      title: "Scan Gmail",
      message:
        "Use search_gmail_invoices then process any subscription invoices from the last 7 days.",
    },
    {
      title: "Dry-run plan",
      message:
        "Dry-run: call create_cancel_calendar_event and post_slack_invoice_alert (channel C0123456789) so we can inspect mcpArguments / apiArguments / restEquivalent.\n\nFrom: receipts@figma.com\nSubject: Figma receipt $45.00\nBody: Invoice FIG-778. Renews 2026-12-01.",
    },
  ],
});
