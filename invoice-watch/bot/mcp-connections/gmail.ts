import { defineConnection } from "@cursor/bdk/connections";

/**
 * Official Google Gmail remote MCP server.
 * Spec: https://developers.google.com/workspace/gmail/api/reference/mcp
 * URL:  https://gmailmcp.googleapis.com/mcp/v1
 *
 * Authorize locally: `npx @cursor/bdk mcp oauth gmail`
 * Underlying REST: users.messages.list / users.messages.get
 * (https://developers.google.com/workspace/gmail/api/reference/rest/v1)
 */
export default defineConnection({
  url: "https://gmailmcp.googleapis.com/mcp/v1",
  oauth: true,
  advertiseTools: true,
  optional: true,
  tools: ["search_threads", "get_message", "get_thread"],
});
