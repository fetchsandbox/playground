import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod/v3";
import {
  buildCancelSubscriptionEvent,
  GOOGLE_CALENDAR_MCP_CONNECTION,
  toRestEventsInsert,
} from "../lib/providers/calendar.js";
import { callProviderTool } from "../lib/providers/mcp-call.js";

const inputSchema = z.object({
  merchant: z.string().min(1),
  amount: z.string().min(1),
  cancelBy: z
    .string()
    .describe("Cancel-by date as YYYY-MM-DD (Calendar start day)"),
  renewalDate: z.string().optional(),
  invoiceId: z.string().optional(),
  notes: z.string().optional(),
  calendarId: z
    .string()
    .optional()
    .describe('Calendar id; default "primary" per Calendar API'),
  timeZone: z
    .string()
    .optional()
    .describe("IANA timezone, e.g. America/Los_Angeles"),
});

export default defineTool({
  description:
    "Create a Google Calendar cancel-subscription reminder via official Calendar MCP create_event (calendars.events.insert). Builds the real provider request before calling.",
  effect: "write",
  inputSchema,
  dryRunResult: (input) => {
    const mcpArgs = buildCancelSubscriptionEvent(input);
    return {
      provider: "google-calendar" as const,
      mcpTool: "create_event" as const,
      dryRun: true as const,
      stubbed: true as const,
      mcpArguments: mcpArgs,
      restEquivalent: toRestEventsInsert(mcpArgs),
    };
  },
  async execute(input, ctx) {
    const mcpArgs = buildCancelSubscriptionEvent(input);
    const rest = toRestEventsInsert(mcpArgs);
    const result = await callProviderTool(
      ctx.host.mcp,
      [GOOGLE_CALENDAR_MCP_CONNECTION, "account"],
      "create_event",
      mcpArgs,
    );

    const eventId =
      (result.structuredContent?.id as string | undefined) ??
      (result.structuredContent?.eventId as string | undefined);

    return {
      provider: "google-calendar" as const,
      mcpTool: "create_event" as const,
      mcpArguments: mcpArgs,
      restEquivalent: rest,
      calendarEventId: eventId,
      ...result,
    };
  },
});
