/**
 * Google Calendar provider contracts.
 *
 * Source of truth:
 * - MCP create_event: https://developers.google.com/workspace/calendar/api/v3/reference/mcp/tools_list/create_event
 * - REST events.insert: https://developers.google.com/calendar/api/v3/reference/events/insert
 * - Create events guide: https://developers.google.com/workspace/calendar/api/guides/create-events
 */

export const GOOGLE_CALENDAR_MCP_CONNECTION = "google-calendar";

/** Official Calendar MCP `create_event` arguments (required + fields we set). */
export type CreateEventArgs = {
  summary: string;
  startTime: string;
  endTime: string;
  calendarId?: string;
  description?: string;
  allDay?: boolean;
  timeZone?: string;
  visibility?: "default" | "public" | "private";
};

export function buildCancelSubscriptionEvent(input: {
  merchant: string;
  cancelBy: string;
  amount: string;
  renewalDate?: string;
  invoiceId?: string;
  notes?: string;
  calendarId?: string;
  timeZone?: string;
}): CreateEventArgs {
  const day = input.cancelBy.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(
      `cancelBy must be YYYY-MM-DD (got ${JSON.stringify(input.cancelBy)})`,
    );
  }

  const lines = [
    `Cancel the ${input.merchant.trim()} subscription before renewal.`,
    `Amount: ${input.amount.trim()}`,
  ];
  if (input.renewalDate) lines.push(`Renewal: ${input.renewalDate.trim()}`);
  if (input.invoiceId) lines.push(`Invoice: ${input.invoiceId.trim()}`);
  if (input.notes) lines.push("", input.notes.trim());

  return {
    summary: `Cancel ${input.merchant.trim()} subscription`,
    // Timed morning block; allDay=false keeps start/end as wall-clock times.
    startTime: `${day}T09:00:00`,
    endTime: `${day}T10:00:00`,
    calendarId: input.calendarId?.trim() || "primary",
    description: lines.join("\n"),
    allDay: false,
    visibility: "private",
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
  };
}

/** Parallel REST events.insert body for documentation / twin verification. */
export function toRestEventsInsert(args: CreateEventArgs) {
  const calendarId = encodeURIComponent(args.calendarId || "primary");
  const useDate = args.allDay === true;
  return {
    method: "POST" as const,
    url: `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
    body: {
      summary: args.summary,
      description: args.description,
      visibility: args.visibility ?? "private",
      start: useDate
        ? { date: args.startTime.slice(0, 10) }
        : {
            dateTime: args.startTime,
            ...(args.timeZone ? { timeZone: args.timeZone } : {}),
          },
      end: useDate
        ? { date: args.endTime.slice(0, 10) }
        : {
            dateTime: args.endTime,
            ...(args.timeZone ? { timeZone: args.timeZone } : {}),
          },
    },
  };
}
