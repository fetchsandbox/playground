import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod/v3";
import {
  buildGetMessageArgs,
  GMAIL_MCP_CONNECTION,
  toRestMessagesGet,
} from "../lib/providers/gmail.js";
import { callProviderTool } from "../lib/providers/mcp-call.js";

export default defineTool({
  description:
    "Fetch one Gmail message via official Gmail MCP get_message (users.messages.get). Use after search_gmail_invoices when you have a message id.",
  effect: "read",
  inputSchema: z.object({
    messageId: z.string().min(1).describe("Gmail message id"),
    messageFormat: z
      .enum(["FULL_CONTENT", "MINIMAL", "METADATA_ONLY"])
      .optional()
      .describe("Gmail MCP messageFormat; default FULL_CONTENT"),
  }),
  async execute({ messageId, messageFormat }, ctx) {
    const mcpArgs = buildGetMessageArgs(messageId, messageFormat);
    const rest = toRestMessagesGet(mcpArgs);
    const result = await callProviderTool(
      ctx.host.mcp,
      [GMAIL_MCP_CONNECTION, "account"],
      "get_message",
      mcpArgs,
    );

    return {
      provider: "gmail" as const,
      mcpTool: "get_message" as const,
      mcpArguments: mcpArgs,
      restEquivalent: rest,
      ...result,
    };
  },
});
