import type { ProviderHttp } from "../kit/http";

export interface DraftEmail {
  to: string;
  subject: string;
  body: string;
  /** Deterministic RFC 5322 Message-ID so a retried draft is recognisable. */
  messageId: string;
}

function header(value: string): string {
  // RFC 2047 encode anything non-ASCII; strip CR/LF so input can't inject headers.
  const clean = value.replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

export function rfc822(mail: DraftEmail, from = "me"): string {
  return [
    `From: ${header(from)}`,
    `To: ${header(mail.to)}`,
    `Subject: ${header(mail.subject)}`,
    `Message-ID: ${mail.messageId}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    mail.body,
  ].join("\r\n");
}

/**
 * Gmail API v1 for the ops mailbox. Customer-facing mail is created as a
 * DRAFT: a person (or the control plane, after approval) sends it.
 */
export class GmailClient {
  constructor(
    readonly http: ProviderHttp,
    private readonly userId = "me",
  ) {}

  async countMessages(q: string): Promise<number> {
    const { body } = await this.http.request<{ messages?: unknown[]; resultSizeEstimate?: number }>("GET", `/gmail/v1/users/${this.userId}/messages`, {
      query: { q, maxResults: 50 },
    });
    return body?.messages?.length ?? 0;
  }

  /**
   * Send a message. messages.send has no idempotency key, so the request is
   * made ONCE: a lost or 5xx answer is ambiguous (Gmail may have accepted it).
   * The caller recovers with findSentByMessageId before ever sending again.
   */
  async sendMessage(mail: DraftEmail): Promise<{ id: string }> {
    const raw = Buffer.from(rfc822(mail), "utf8").toString("base64url");
    const { body } = await this.http.request<{ id: string }>("POST", `/gmail/v1/users/${this.userId}/messages/send`, { json: { raw }, retries: 0 });
    return { id: body.id };
  }

  /** The already-sent message carrying this RFC 5322 Message-ID, if any (Gmail search operator rfc822msgid:). */
  async findSentByMessageId(messageId: string): Promise<{ id: string } | undefined> {
    const { body } = await this.http.request<{ messages?: { id: string }[] }>("GET", `/gmail/v1/users/${this.userId}/messages`, {
      query: { q: `rfc822msgid:${messageId.replace(/^<|>$/g, "")}`, maxResults: 5 },
    });
    for (const m of body?.messages ?? []) {
      // Confirm the header rather than trusting the search index alone.
      const { body: full } = await this.http.request<{ id: string; payload?: { headers?: { name: string; value: string }[] } }>("GET", `/gmail/v1/users/${this.userId}/messages/${encodeURIComponent(m.id)}`);
      const hdr = full?.payload?.headers?.find((h) => h.name.toLowerCase() === "message-id")?.value;
      if (!hdr || hdr.trim() === messageId) return { id: full.id ?? m.id };
    }
    return undefined;
  }

  async createDraft(mail: DraftEmail): Promise<{ id: string }> {
    const raw = Buffer.from(rfc822(mail), "utf8").toString("base64url");
    const { body } = await this.http.request<{ id: string }>("POST", `/gmail/v1/users/${this.userId}/drafts`, { json: { message: { raw } } });
    return { id: body.id };
  }
}

export interface Slot {
  start: string;
  end: string;
}

export interface CalendarEvent {
  id: string;
  summary?: string;
  status?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  attendees?: { email: string }[];
  reminders?: { useDefault?: boolean; overrides?: { method: string; minutes: number }[] };
  extendedProperties?: { private?: Record<string, string> };
}

/** Google Calendar API v3. */
export class CalendarClient {
  constructor(readonly http: ProviderHttp) {}

  async busy(calendarId: string, timeMin: string, timeMax: string): Promise<Slot[]> {
    const { body } = await this.http.request<any>("POST", "/calendar/v3/freeBusy", { json: { timeMin, timeMax, items: [{ id: calendarId }] } });
    const cal = body?.calendars?.[calendarId];
    return Array.isArray(cal?.busy) ? cal.busy : [];
  }

  async insertEvent(
    calendarId: string,
    event: { summary: string; description: string; start: string; end: string; attendees?: string[]; privateKey: string; reminderMinutes?: number[]; privateProps?: Record<string, string> },
    sendUpdates: "none" | "all",
  ): Promise<CalendarEvent> {
    const { body } = await this.http.request<CalendarEvent>("POST", `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
      query: { sendUpdates },
      json: {
        summary: event.summary,
        description: event.description,
        start: { dateTime: event.start },
        end: { dateTime: event.end },
        attendees: event.attendees?.map((email) => ({ email })),
        ...(event.reminderMinutes ? { reminders: { useDefault: false, overrides: event.reminderMinutes.map((minutes) => ({ method: "popup", minutes })) } } : {}),
        // Lets a retry find the event it already created.
        extendedProperties: { private: { ...event.privateProps, acmeKey: event.privateKey } },
      },
    });
    return body;
  }

  async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent> {
    return (await this.http.request<CalendarEvent>("GET", `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`)).body;
  }
}

/**
 * First free slot of `minutes` within working hours (UTC) over the next
 * `days` business days, starting tomorrow. Pure: the caller supplies `now`.
 */
export function firstFreeSlot(busy: Slot[], now: Date, minutes = 30, days = 5, hours: [number, number] = [15, 22]): Slot | undefined {
  const taken = busy.map((b) => [Date.parse(b.start), Date.parse(b.end)] as const);
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let d = 1, found = 0; found < days && d < days + 10; d++) {
    const date = new Date(day.getTime() + d * 86_400_000);
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    found++;
    for (let t = hours[0] * 60; t + minutes <= hours[1] * 60; t += 30) {
      const s = date.getTime() + t * 60_000;
      const e = s + minutes * 60_000;
      if (!taken.some(([bs, be]) => s < be && e > bs)) return { start: new Date(s).toISOString(), end: new Date(e).toISOString() };
    }
  }
  return undefined;
}
