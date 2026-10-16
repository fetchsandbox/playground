import { defineAgent } from "@cursor/bdk";

export default defineAgent({
  description:
    "Watches subscription invoice emails via Gmail MCP, creates Google Calendar cancel reminders, and posts Slack chat.postMessage alerts.",
  model: {
    id: "grok-4.5",
    params: [
      { id: "effort", value: "high" },
      { id: "fast", value: "true" },
    ],
  },
  hosting: {
    egressDomains: [
      "gmailmcp.googleapis.com",
      "calendarmcp.googleapis.com",
      "gmail.googleapis.com",
      "www.googleapis.com",
      "slack.com",
      "mcp.slack.com",
    ],
    secretNames: [
      "INVOICE_WATCH_SLACK_BOT_TOKEN",
      "INVOICE_WATCH_SLACK_APP_TOKEN",
    ],
  },
});
