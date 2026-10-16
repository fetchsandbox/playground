import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod/v3";
import {
  buildSearchThreadsArgs,
  GMAIL_MCP_CONNECTION,
  toRestMessagesList,
} from "../lib/providers/gmail.js";
import { callProviderTool } from "../lib/providers/mcp-call.js";

export default defineTool({
  description:
    "Search Gmail for subscription/invoice threads via official Gmail MCP search_threads (Gmail search `q` operators). Returns the MCP args plus the parallel users.messages.list REST shape.",
  effect: "read",
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .describe(
        "Gmail search box query. Omit to use the default invoice/subscription query.",
      ),
    newerThan: z
      .string()
      .optional()
      .describe("Gmail newer_than duration when using the default query, e.g. 7d"),
    pageSize: z.number().int().min(1).max(50).optional(),
    pageToken: z.string().optional(),
  }),
  async execute(input, ctx) {
    const mcpArgs = buildSearchThreadsArgs(input);
    const rest = toRestMessagesList(mcpArgs);
    const result = await callProviderTool(
      ctx.host.mcp,
      [GMAIL_MCP_CONNECTION, "account"],
      "search_threads",
      mcpArgs,
    );

    return {
      provider: "gmail" as const,
      mcpTool: "search_threads" as const,
      mcpArguments: mcpArgs,
      restEquivalent: rest,
      ...result,
    };
  },
});
