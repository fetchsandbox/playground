import { defineEval, includes } from "@cursor/bdk/evals";

export default defineEval({
  tags: ["smoke", "invoice"],
  cases: [
    {
      id: "pasted-notion-invoice",
      description:
        "Pasted Notion invoice should dedupe, build real Calendar create_event + Slack chat.postMessage payloads, and record.",
      async test(t) {
        await t.send(
          [
            "Dry-run / plan-only: process this subscription invoice against real provider contracts.",
            "Call check_invoice_processed, create_cancel_calendar_event, post_slack_invoice_alert (channel C0123456789), and record_processed_invoice with dryRun true.",
            "Do not invent missing fields. Prefer authored tools over free-form MCP guesses.",
            "",
            "From: billing@notion.so",
            "Subject: Your Notion invoice for $29.00",
            "Body: Invoice INV-1001. Amount $29.00 USD. Next renewal 2026-11-15. Cancel anytime before renewal.",
          ].join("\n"),
        );

        t.succeeded();
        t.calledTool("check_invoice_processed");
        t.calledTool("create_cancel_calendar_event", {
          input: { merchant: /notion/i },
        });
        t.calledTool("post_slack_invoice_alert", {
          input: { channel: "C0123456789" },
        });
        t.calledTool("record_processed_invoice", {
          input: { merchant: /notion/i },
        });
        t.check(t.reply, includes(/cancel/i));
      },
    },
  ],
});
