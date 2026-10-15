import { defineConnection } from "@cursor/bdk/connections";

/**
 * Official Google Calendar remote MCP server.
 * Spec: https://developers.google.com/workspace/calendar/api/v3/reference/mcp
 * URL:  https://calendarmcp.googleapis.com/mcp/v1
 *
 * Authorize locally: `npx @cursor/bdk mcp oauth google-calendar`
 * Underlying REST: calendars.events.insert
 * (https://developers.google.com/calendar/api/v3/reference/events/insert)
 */
export default defineConnection({
  url: "https://calendarmcp.googleapis.com/mcp/v1",
  oauth: true,
  advertiseTools: true,
  optional: true,
  tools: ["create_event", "list_calendars", "list_events", "get_event"],
});
