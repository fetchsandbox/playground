import { z } from "zod";
import { SkipAction } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import type { Providers } from "../providers";
import { ChannelId, Email, messageId, out } from "./shared";

// People · hr-compliance.
// Trigger: a row in the HR compliance register (Notion) is created or edited.
// A row is either an employee's work authorization (document and expiry date)
// or a leave of absence (expected return date). Durable timers from the date:
//   work authorization — notices to HR at 180, 90 and 30 days; at 90 days an
//   Asana case for immigration counsel; on the expiry date, with no renewal
//   recorded, the row is marked "reverification overdue" and HR is told the
//   employee can't keep working until the I-9 is reverified;
//   leave — 14 days before the return date the employee gets a return-planning
//   email (draft) and a return meeting with their manager is booked; the day
//   after the return date, if the row isn't marked returned, HR is told to
//   check for an extension (job protection).
// Every timer re-reads the row: an edited date or a renewed / returned status
// means a newer run owns the row and this one stands down.

export const POLICY = { authNoticeDays: [180, 90, 30], counselAtDays: 90, leavePlanDays: 14 } as const;
const DAY = 86_400_000;

const Input = z.object({
  eventId: z.string().regex(/^evt_[\w-]{6,64}$/),
  pageId: z.string().regex(/^[0-9a-f-]{32,36}$/i, "Notion page id"),
  hrChannel: ChannelId,
  counselWorkspace: z.string().min(1).default("acme-immigration"),
  hrCalendarId: z.string().min(3).max(200),
});
type Input = z.infer<typeof Input>;

export interface Row {
  kind: "work_authorization" | "leave";
  employee: string;
  email: string | null;
  managerEmail: string | null;
  document: string | null;
  date: string;
  status: string;
  edited: string;
}

const text = (p: any) => (p?.rich_text ?? p?.title ?? []).map((t: any) => t.plain_text ?? t.text?.content ?? "").join("") || null;
/** Reads the register's columns: Employee (title), Email, Manager email, Type, Document, Date, Status. */
export function readRow(page: { last_edited_time?: string; properties: Record<string, any> }): Row | null {
  const p = page.properties;
  const kind = p.Type?.select?.name;
  const date = p.Date?.date?.start;
  if (!["work_authorization", "leave"].includes(kind) || !date) return null;
  return { kind, employee: text(p.Employee) ?? "employee", email: p.Email?.email ?? text(p.Email), managerEmail: p["Manager email"]?.email ?? text(p["Manager email"]), document: p.Document?.select?.name ?? text(p.Document), date: date.slice(0, 10), status: p.Status?.select?.name ?? "active", edited: page.last_edited_time ?? "" };
}

const at = (date: string, days: number) => new Date(Date.parse(`${date}T15:00:00Z`) + days * DAY).toISOString();

export const visaAndLeaveExpiry: WorkflowDef<Input> = {
  id: "visa-and-leave-expiry",
  title: "Work authorization and leave dates",
  org: "People",
  team: "hr-compliance",
  description:
    "From a Notion HR compliance row, schedule work-authorization notices (180/90/30 days), an immigration counsel case at 90 days and an I-9 reverification escalation on expiry; for leaves, a return-planning email and manager meeting 14 days before return and an extension check the day after; every timer stands down if the row changed.",
  input: Input,
  audit: true,
  tickEvery: "rate(1 hour)",
  agents: [
    {
      name: "register",
      needs: ["notion"],
      async run({ input, providers }) {
        const row = readRow(await providers.notion!.getPage(input.pageId));
        return { summary: row ? `${row.kind} for ${row.employee}: ${row.date} (${row.status})` : "not a work-authorization or leave row", data: row };
      },
    },
  ],

  plan({ input, startedAt }, results) {
    const row = out<Row | null>(results, "register");
    if (row === undefined) {
      return [
        {
          id: "slack.post_unreadable",
          kind: "slack.post_unreadable",
          provider: "slack",
          agent: "register",
          gate: "auto",
          summary: { page: input.pageId },
          async execute({ providers }) {
            return { ref: (await providers.slack!.postMessage(input.hrChannel, `:warning: HR register row ${input.pageId} could not be read; its date reminders are not scheduled.`)).ts };
          },
        },
      ];
    }
    if (!row || ["renewed", "returned", "closed"].includes(row.status)) return [];
    const now = startedAt.getTime();
    /** Stands down when the row has moved on since this run read it. */
    const same = async (providers: Providers) => {
      const cur = readRow(await providers.notion!.getPage(input.pageId));
      if (!cur || cur.date !== row.date || cur.kind !== row.kind) throw new SkipAction("row changed; a newer run owns it");
      if (["renewed", "returned", "closed"].includes(cur.status)) throw new SkipAction(`row is ${cur.status}`);
      return cur;
    };
    const post = (text: string) => async (providers: Providers) => ({ ref: (await providers.slack!.postMessage(input.hrChannel, text)).ts });
    const actions: PlannedAction<Input>[] = [];
    const future = (iso: string) => Date.parse(iso) > now;

    if (row.kind === "work_authorization") {
      for (const d of POLICY.authNoticeDays) {
        const when = at(row.date, -d);
        if (!future(when)) continue;
        actions.push({
          id: `hr.auth_notice:${d}`,
          kind: "hr.auth_notice",
          provider: "slack",
          agent: "register",
          gate: "auto",
          summary: { employee: row.employee, document: row.document, expires: row.date, daysBefore: d },
          waitUntil: when,
          async execute({ providers }) {
            await same(providers);
            return post(`:passport_control: ${row.employee}'s ${row.document ?? "work authorization"} expires ${row.date} (${d} days).${d === POLICY.counselAtDays ? " Immigration counsel has been asked to open the renewal." : ""}`)(providers);
          },
        });
      }
      const counselAt = at(row.date, -POLICY.counselAtDays);
      actions.push({
        id: "asana.counsel_case",
        kind: "asana.counsel_case",
        provider: "asana",
        agent: "register",
        gate: "auto",
        summary: { employee: row.employee, document: row.document, expires: row.date },
        ...(future(counselAt) ? { waitUntil: counselAt } : {}),
        async execute({ providers }) {
          await same(providers);
          const t = await providers.asana!.createTask({ name: `Renewal: ${row.employee} — ${row.document ?? "work authorization"} expires ${row.date}`, notes: `Register row ${input.pageId}. File the renewal or extension and update the register when approved.`, workspace: input.counselWorkspace, due_on: at(row.date, -30).slice(0, 10) });
          return { ref: t.gid };
        },
      });
      actions.push({
        id: "hr.reverification_overdue",
        kind: "hr.reverification_overdue",
        provider: "notion",
        agent: "register",
        gate: "auto",
        summary: { employee: row.employee, expires: row.date },
        waitUntil: at(row.date, 0),
        async execute({ providers }) {
          await same(providers);
          await providers.notion!.updatePage(input.pageId, { Status: { select: "reverification_overdue" } });
          await providers.slack!.postMessage(input.hrChannel, `:rotating_light: ${row.employee}'s ${row.document ?? "work authorization"} expired today with no renewal recorded. Form I-9 must be reverified before they continue working.`);
          return { ref: input.pageId };
        },
      });
    } else {
      const plan = at(row.date, -POLICY.leavePlanDays);
      const email = `gmail.return_planning`;
      if (row.email) {
        actions.push({
          id: email,
          kind: "gmail.return_planning",
          provider: "gmail",
          agent: "register",
          gate: "auto",
          summary: { employee: row.employee, returns: row.date, sent: false },
          ...(future(plan) ? { waitUntil: plan } : {}),
          async execute({ providers, runId }) {
            await same(providers);
            const d = await providers.gmail!.createDraft({ to: row.email!, subject: "Planning your return", body: `Hi ${row.employee.split(" ")[0]},\n\nWe're looking forward to having you back on ${row.date}. Your manager will meet you that morning; reply if your return date has changed or you'd like a phased return.\n\nPeople team`, messageId: messageId(runId, `return-${input.pageId}`) });
            return { ref: d.id };
          },
        });
      }
      if (row.managerEmail && row.email) {
        actions.push({
          id: "calendar.return_meeting",
          kind: "calendar.return_meeting",
          provider: "calendar",
          agent: "register",
          gate: "auto",
          summary: { employee: row.employee, on: row.date },
          ...(future(plan) ? { waitUntil: plan } : {}),
          async execute({ providers }) {
            await same(providers);
            const ev = await providers.calendar!.insertEvent(input.hrCalendarId, { summary: `Welcome back: ${row.employee}`, description: "Return-from-leave check-in.", start: `${row.date}T16:00:00Z`, end: `${row.date}T16:30:00Z`, attendees: [row.email!, row.managerEmail!], privateKey: `return-${input.pageId}-${row.date}` }, "all");
            return { ref: ev.id };
          },
        });
      }
      actions.push({
        id: "hr.return_check",
        kind: "hr.return_check",
        provider: "slack",
        agent: "register",
        gate: "auto",
        summary: { employee: row.employee, expected: row.date },
        waitUntil: at(row.date, 1),
        async execute({ providers }) {
          await same(providers);
          return post(`:calendar: ${row.employee} was due back from leave on ${row.date} and the register doesn't show a return. Check for an extension before anything affects their job protection.`)(providers);
        },
      });
    }
    return actions;
  },

  output(_ctx, results) {
    const row = out<Row | null>(results, "register");
    if (row === undefined) return { mode: "blocked" };
    if (!row) return { mode: "ignored" };
    return { mode: row.kind, date: row.date, status: row.status };
  },

  catalog: [
    { kind: "hr.auth_notice", provider: "slack", gate: "auto", description: "Work authorization notices at 180, 90 and 30 days" },
    { kind: "asana.counsel_case", provider: "asana", gate: "auto", description: "Immigration counsel renewal case at 90 days" },
    { kind: "hr.reverification_overdue", provider: "notion", gate: "auto", description: "Expired without renewal: mark the row, escalate I-9 reverification" },
    { kind: "gmail.return_planning", provider: "gmail", gate: "auto", description: "Return-planning email (draft) 14 days before return" },
    { kind: "calendar.return_meeting", provider: "calendar", gate: "auto", description: "Manager check-in on the return day" },
    { kind: "hr.return_check", provider: "slack", gate: "auto", description: "No return recorded the day after: check for an extension" },
    { kind: "slack.post_unreadable", provider: "slack", gate: "auto", description: "Row unreadable: nothing scheduled" },
  ],
};
