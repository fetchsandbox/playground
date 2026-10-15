import { slackChannel } from "@cursor/bdk/channels/slack";

/**
 * Inbound Slack wake channel. Missing tokens mount idle — run
 * `npx @cursor/bdk slack create --dir . --name "Invoice Watch"` to mint
 * INVOICE_WATCH_SLACK_BOT_TOKEN / INVOICE_WATCH_SLACK_APP_TOKEN.
 * Outbound invoice alerts use the Slack Cursor-account MCP connector.
 */
export default slackChannel({
  envPrefix: "INVOICE_WATCH",
  suggestedPromptsTitle: "Try asking",
  suggestedPrompts: [
    {
      title: "Process pasted invoice",
      message:
        "Process this subscription invoice: create a cancel reminder on Calendar and alert Slack.\n\nFrom: billing@notion.so\nSubject: Your Notion invoice for $29.00\nBody: Invoice INV-1001. Next renewal 2026-11-15. Cancel anytime before renewal.",
    },
    {
      title: "Scan Gmail",
      message:
        "Scan Gmail for new subscription invoices from the last 7 days and process any you find.",
    },
    {
      title: "Dry-run plan",
      message:
        "Dry-run only: extract fields from the pasted invoice below, check dedupe, and show the Calendar event + Slack message you would create. Do not rely on live writes.\n\nFrom: receipts@figma.com\nSubject: Figma receipt $45.00\nBody: Invoice FIG-778. Renews 2026-12-01.",
    },
  ],
});
