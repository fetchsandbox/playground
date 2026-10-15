import { defineAgent } from "@cursor/bdk";

export default defineAgent({
  description:
    "Watches subscription invoice emails, creates Google Calendar cancel reminders, and posts Slack alerts.",
  model: {
    id: "grok-4.5",
    params: [
      { id: "effort", value: "high" },
      { id: "fast", value: "true" },
    ],
  },
  hosting: {
    secretNames: [
      "INVOICE_WATCH_SLACK_BOT_TOKEN",
      "INVOICE_WATCH_SLACK_APP_TOKEN",
    ],
  },
});
