/**
 * Slack provider contracts.
 *
 * Source of truth:
 * - Web API chat.postMessage: https://docs.slack.dev/reference/methods/chat.postMessage
 * - Node SDK: @slack/web-api WebClient.chat.postMessage
 * - Official Slack MCP (optional transport): https://mcp.slack.com/mcp
 *   (docs.slack.dev/ai/slack-mcp-server) — Send message requires chat:write
 *
 * This agent posts via the Slack Web API SDK (`ctx.host.slack.getClient()`),
 * which is the same chat.postMessage contract as the REST method.
 */

/** Official chat.postMessage arguments we send. */
export type ChatPostMessageArgs = {
  channel: string;
  text: string;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
};

export function buildInvoiceAlertMessage(input: {
  channel: string;
  merchant: string;
  amount: string;
  renewalDate?: string;
  cancelBy?: string;
  invoiceKey: string;
  calendarEventId?: string;
}): ChatPostMessageArgs {
  const lines = [
    `Subscription invoice: ${input.merchant.trim()} — ${input.amount.trim()}`,
  ];
  if (input.renewalDate || input.cancelBy) {
    lines.push(
      [
        input.renewalDate ? `Renews: ${input.renewalDate.trim()}` : null,
        input.cancelBy ? `Cancel by: ${input.cancelBy.trim()}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }
  lines.push(
    input.calendarEventId
      ? `Calendar event: ${input.calendarEventId}`
      : "Calendar reminder created.",
  );
  lines.push(`Invoice key: ${input.invoiceKey.trim()}`);

  return {
    channel: input.channel.trim(),
    text: lines.join("\n"),
    unfurl_links: false,
    unfurl_media: false,
  };
}

/** Parallel REST shape for documentation / twin verification. */
export function toRestChatPostMessage(args: ChatPostMessageArgs) {
  return {
    method: "POST" as const,
    url: "https://slack.com/api/chat.postMessage",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: "Bearer xoxb-…",
    },
    body: {
      channel: args.channel,
      text: args.text,
      unfurl_links: args.unfurl_links ?? false,
      unfurl_media: args.unfurl_media ?? false,
    },
  };
}
