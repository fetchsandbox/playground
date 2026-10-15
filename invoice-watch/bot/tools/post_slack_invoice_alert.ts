import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod/v3";
import {
  buildInvoiceAlertMessage,
  toRestChatPostMessage,
} from "../lib/providers/slack.js";

const inputSchema = z.object({
  channel: z
    .string()
    .min(1)
    .describe("Slack channel ID (C…) or name; chat.postMessage channel"),
  merchant: z.string().min(1),
  amount: z.string().min(1),
  invoiceKey: z.string().min(3),
  renewalDate: z.string().optional(),
  cancelBy: z.string().optional(),
  calendarEventId: z.string().optional(),
});

export default defineTool({
  description:
    "Post a subscription invoice alert via Slack Web API chat.postMessage (@slack/web-api). Builds the real provider request before calling.",
  effect: "write",
  inputSchema,
  dryRunResult: (input) => {
    const apiArgs = buildInvoiceAlertMessage(input);
    return {
      provider: "slack" as const,
      apiMethod: "chat.postMessage" as const,
      dryRun: true as const,
      stubbed: true as const,
      apiArguments: apiArgs,
      restEquivalent: toRestChatPostMessage(apiArgs),
    };
  },
  async execute(input, ctx) {
    const apiArgs = buildInvoiceAlertMessage(input);

    try {
      const client = await ctx.host.slack.getClient();
      const posted = await client.chat.postMessage(apiArgs);

      if (!posted.ok) {
        return {
          provider: "slack" as const,
          apiMethod: "chat.postMessage" as const,
          ok: false as const,
          apiArguments: apiArgs,
          restEquivalent: toRestChatPostMessage(apiArgs),
          error: posted.error ?? "chat.postMessage returned ok:false",
        };
      }

      return {
        provider: "slack" as const,
        apiMethod: "chat.postMessage" as const,
        ok: true as const,
        apiArguments: apiArgs,
        restEquivalent: toRestChatPostMessage(apiArgs),
        channel: posted.channel,
        ts: posted.ts,
        slackMessageRef:
          posted.channel && posted.ts
            ? `${posted.channel}:${posted.ts}`
            : undefined,
      };
    } catch (err) {
      return {
        provider: "slack" as const,
        apiMethod: "chat.postMessage" as const,
        ok: false as const,
        apiArguments: apiArgs,
        restEquivalent: toRestChatPostMessage(apiArgs),
        error:
          err instanceof Error
            ? err.message
            : String(err),
        hint: "Mint Slack bot tokens with: npx @cursor/bdk slack create --dir . --name \"Invoice Watch\"",
      };
    }
  },
});
