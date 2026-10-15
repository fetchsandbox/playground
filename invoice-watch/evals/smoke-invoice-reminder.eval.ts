import { defineEval, includes } from "@cursor/bdk/evals";

export default defineEval({
  tags: ["smoke", "invoice"],
  cases: [
    {
      id: "pasted-notion-invoice",
      description:
        "Pasted Notion invoice should dedupe-check, record, and mention Calendar + Slack actions.",
      async test(t) {
        await t.send(
          [
            "Dry-run / plan-only: process this subscription invoice.",
            "Extract fields, call check_invoice_processed, then record_processed_invoice with dryRun true.",
            "Describe the Google Calendar cancel reminder and Slack message you would create.",
            "Do not invent missing fields.",
            "",
            "From: billing@notion.so",
            "Subject: Your Notion invoice for $29.00",
            "Body: Invoice INV-1001. Amount $29.00 USD. Next renewal 2026-11-15. Cancel anytime before renewal.",
          ].join("\n"),
        );

        t.succeeded();
        t.calledTool("check_invoice_processed");
        t.calledTool("record_processed_invoice", {
          input: { merchant: /notion/i },
        });
        t.check(t.reply, includes(/cancel/i));
        t.check(t.reply, includes(/slack/i));
      },
    },
  ],
});
