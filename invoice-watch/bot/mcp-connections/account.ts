import { defineConnection } from "@cursor/bdk/connections";

/**
 * Forwards the signed-in Cursor account's Gmail, Google Calendar, and
 * Slack connectors. Connect those servers in the Cursor MCP dashboard
 * (or Deployed Agents for hosted runs). `optional` keeps local serve
 * up when the account is unsigned or a connector is missing.
 */
export default defineConnection({
  cursorAccount: true,
  servers: ["Gmail", "Google Calendar", "Slack"],
  advertiseTools: true,
  optional: true,
});
