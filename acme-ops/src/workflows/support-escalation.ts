import { z } from "zod";
import { firstFreeSlot, type Slot } from "../providers/google";
import { LIVE_SUB_STATES } from "../providers/stripe";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { Approvers, ChannelId, Email, messageId, money, out, plain } from "./shared";

// Support org · support-ops team.
// Trigger: a Zendesk ticket (new or updated) forwarded by the control plane.

const Input = z.object({
  ticket: z.object({
    id: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform(String),
    subject: z.string().max(500).default(""),
    description: z.string().max(20_000).default(""),
    requester: z.object({ email: Email, name: z.string().max(200).optional() }),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    tags: z.array(z.string().max(80)).max(50).default([]),
  }),
  escalationChannel: ChannelId,
  /** Calendar of the support lead who takes escalation callbacks. */
  supportCalendarId: z.string().min(1).default("primary"),
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

type Severity = "urgent" | "high" | "normal" | "low";
type Category = "outage" | "security" | "billing" | "bug" | "how_to";

interface Triage {
  source: "zendesk" | "trigger_payload";
  subject: string;
  severity: Severity;
  category: Category;
  signals: string[];
}
interface Account {
  found: boolean;
  contactId?: string;
  lifecycle?: string;
  company?: string;
}
interface Billing {
  found: boolean;
  customerId?: string;
  liveSubscriptions: number;
  pastDue: boolean;
  openInvoices: number;
  amountDueMinor: number;
  currency: string;
}
interface Availability {
  slot?: Slot;
}
interface Composed {
  severity: Severity;
  escalate: boolean;
  reasons: string[];
  reply: { subject: string; body: string; draftedBy: string };
  brief: string;
}

const RULES: { category: Category; severity: Severity; re: RegExp }[] = [
  { category: "security", severity: "urgent", re: /\b(breach|leak(ed)?|unauthori[sz]ed|compromis\w*|security|phish\w*)\b/i },
  { category: "outage", severity: "urgent", re: /\b(outage|down|unavailable|cannot log ?in|can't log ?in|data loss|5\d\d error)\b/i },
  { category: "billing", severity: "normal", re: /\b(invoice|charged?|refund|billing|payment|card|overcharg\w*)\b/i },
  { category: "bug", severity: "normal", re: /\b(bug|error|broken|crash\w*|fails?|failing)\b/i },
];
const ORDER: Severity[] = ["low", "normal", "high", "urgent"];
const bump = (s: Severity): Severity => ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(s) + 1)]!;

export function triage(subject: string, description: string, tags: string[], declared?: Severity): Omit<Triage, "source" | "subject"> {
  const text = `${subject}\n${description}\n${tags.join(" ")}`;
  const hits = RULES.filter((r) => r.re.test(text));
  const top = hits[0];
  let severity: Severity = top?.severity ?? "low";
  if (declared && ORDER.indexOf(declared) > ORDER.indexOf(severity)) severity = declared;
  return { severity, category: top?.category ?? "how_to", signals: hits.map((h) => h.category) };
}

export const supportEscalation: WorkflowDef<Input> = {
  id: "support-escalation",
  title: "Support escalation",
  org: "Support",
  team: "support-ops",
  description:
    "Triage a Zendesk ticket against the customer's CRM record, billing health and the support lead's calendar; annotate the ticket, escalate in Slack, hold a callback slot and draft the reply. The public reply waits for approval.",
  input: Input,
  agents: [
    {
      name: "ticket-triage",
      needs: [],
      async run({ input, providers }) {
        let { subject, description, tags, priority } = input.ticket;
        let source: Triage["source"] = "trigger_payload";
        // Zendesk is the source of truth when connected; the trigger payload may be stale.
        if (providers.zendesk) {
          const t = await providers.zendesk.getTicket(input.ticket.id);
          subject = t.subject ?? subject;
          description = t.description ?? description;
          tags = t.tags ?? tags;
          priority = (t.priority as Severity | null) ?? priority;
          source = "zendesk";
        }
        const data: Triage = { source, subject, ...triage(subject, description, tags, priority) };
        return { summary: `${data.severity} ${data.category} (${source})`, data };
      },
    },
    {
      name: "account-context",
      needs: ["hubspot"],
      async run({ input, providers }) {
        const c = await providers.hubspot!.findByEmail(input.ticket.requester.email);
        const data: Account = c
          ? { found: true, contactId: c.id, lifecycle: c.properties.lifecyclestage ?? undefined, company: c.properties.company ?? undefined }
          : { found: false };
        return { summary: c ? `HubSpot contact ${c.id} (${data.lifecycle ?? "no stage"})` : "not in HubSpot", data };
      },
    },
    {
      name: "billing-health",
      needs: ["stripe"],
      async run({ input, providers }) {
        const stripe = providers.stripe!;
        const customer = await stripe.findCustomerByEmail(input.ticket.requester.email);
        if (!customer) return { summary: "no Stripe customer", data: { found: false, liveSubscriptions: 0, pastDue: false, openInvoices: 0, amountDueMinor: 0, currency: "usd" } satisfies Billing };
        const [subs, invoices] = await Promise.all([stripe.listSubscriptions(customer.id), stripe.listInvoices(customer.id, "open")]);
        const mine = subs.filter((s) => s.customer === customer.id);
        const open = invoices.filter((i) => i.customer === customer.id && i.status === "open");
        const data: Billing = {
          found: true,
          customerId: customer.id,
          liveSubscriptions: mine.filter((s) => LIVE_SUB_STATES.has(s.status)).length,
          pastDue: mine.some((s) => s.status === "past_due" || s.status === "unpaid"),
          openInvoices: open.length,
          amountDueMinor: open.reduce((n, i) => n + (i.amount_remaining ?? i.amount_due ?? 0), 0),
          currency: open[0]?.currency ?? "usd",
        };
        return { summary: `${data.liveSubscriptions} live sub(s)${data.pastDue ? ", PAST DUE" : ""}, ${money(data.amountDueMinor, data.currency)} open`, data };
      },
    },
    {
      name: "callback-availability",
      needs: ["calendar"],
      async run({ input, providers, startedAt }) {
        const from = new Date(startedAt.getTime());
        const to = new Date(startedAt.getTime() + 10 * 86_400_000);
        const busy = await providers.calendar!.busy(input.supportCalendarId, from.toISOString(), to.toISOString());
        const slot = firstFreeSlot(busy, startedAt);
        return { summary: slot ? `free ${slot.start}` : "no free slot in 5 business days", data: { slot } satisfies Availability };
      },
    },
  ],

  compose: {
    name: "reply-composer",
    async run({ input, drafter }, results) {
      const t = out<Triage>(results, "ticket-triage");
      const acct = out<Account>(results, "account-context");
      const bill = out<Billing>(results, "billing-health");
      const severity0: Severity = t?.severity ?? (input.ticket.priority as Severity) ?? "normal";
      const reasons: string[] = [];
      // Paying customers get one notch more urgency; owing customers with a
      // billing ticket are escalated to make sure nobody chases them blindly.
      const paying = (bill?.liveSubscriptions ?? 0) > 0 || acct?.lifecycle === "customer";
      let severity = severity0;
      if (paying && severity !== "urgent") {
        severity = bump(severity);
        reasons.push("paying customer");
      }
      if (bill?.pastDue && t?.category === "billing") {
        severity = ORDER.indexOf(severity) < ORDER.indexOf("high") ? "high" : severity;
        reasons.push("billing ticket on a past-due account");
      }
      if (t?.signals.includes("security")) reasons.push("security signal");
      if (t?.signals.includes("outage")) reasons.push("outage signal");
      const escalate = severity === "urgent" || severity === "high";
      const name = input.ticket.requester.name?.split(" ")[0] ?? "there";
      const brief = [
        `Severity ${severity}${reasons.length ? ` (${reasons.join("; ")})` : ""}.`,
        acct?.found ? `HubSpot: ${acct.company ?? "unknown company"}, stage ${acct.lifecycle ?? "n/a"}.` : "Not in HubSpot.",
        bill?.found
          ? `Stripe: ${bill.liveSubscriptions} live subscription(s), ${bill.openInvoices} open invoice(s) totalling ${money(bill.amountDueMinor, bill.currency)}${bill.pastDue ? ", past due" : ""}.`
          : "No Stripe customer.",
      ].join(" ");
      const reply = await drafter.draft({
        task: "support-reply",
        instructions: `Draft the first reply to this support ticket. Acknowledge the issue, say what happens next${escalate ? " (it has been escalated to the support lead)" : ""}, and do not promise refunds, credits or timelines.`,
        facts: { ticketSubject: t?.subject ?? input.ticket.subject, ticketBody: input.ticket.description.slice(0, 4000), customerFirstName: name, severity },
        fallback: {
          subject: `Re: ${plain(t?.subject ?? input.ticket.subject, 150) || `ticket #${input.ticket.id}`}`,
          body: `Hi ${name},\n\nThanks for reaching out. We've received your request (#${input.ticket.id}) and ${escalate ? "escalated it to our support lead, who will follow up shortly" : "a specialist is looking into it"}.\n\nWe'll keep you posted on this ticket.\n\nACME Support`,
        },
      });
      const data: Composed = { severity, escalate, reasons, reply, brief };
      return { summary: `${severity}${escalate ? ", escalate" : ""}; reply by ${reply.draftedBy}`, data };
    },
  },

  plan({ input }, results) {
    const c = out<Composed>(results, "reply-composer");
    const t = out<Triage>(results, "ticket-triage");
    const slot = out<Availability>(results, "callback-availability")?.slot;
    if (!c) return [];
    const ticketId = input.ticket.id;
    const actions: PlannedAction<Input>[] = [];

    actions.push({
      id: "zendesk.annotate_ticket",
      kind: "zendesk.annotate_ticket",
      provider: "zendesk",
      agent: "reply-composer",
      gate: "auto",
      summary: { ticketId, priority: c.severity, tags: ["acme-triaged", `cat-${t?.category ?? "unknown"}`], internalNote: true },
      async execute({ providers }) {
        const tk = await providers.zendesk!.updateTicket(ticketId, {
          priority: c.severity === "low" ? "low" : c.severity,
          tags: ["acme-triaged", `cat-${t?.category ?? "unknown"}`, ...(c.escalate ? ["acme-escalated"] : [])],
          comment: { body: `[ops agent] ${c.brief}`, public: false },
        });
        return { ref: String(tk?.id ?? ticketId), detail: { priority: c.severity } };
      },
      async reconcile({ providers }) {
        const tk = await providers.zendesk!.getTicket(ticketId);
        const want = c.severity === "low" ? "low" : c.severity;
        return tk.priority === want ? { status: "match" } : { status: "drift", detail: `priority is ${tk.priority}, expected ${want}` };
      },
    });

    if (c.escalate) {
      actions.push({
        id: "slack.post_escalation",
        kind: "slack.post_escalation",
        provider: "slack",
        agent: "reply-composer",
        gate: "auto",
        summary: { channel: input.escalationChannel, ticketId, severity: c.severity },
        async execute({ providers }) {
          const text = `:rotating_light: ${c.severity.toUpperCase()} ticket #${ticketId} from ${input.ticket.requester.email}: ${plain(t?.subject ?? input.ticket.subject, 150)}\n${plain(c.brief, 600)}${slot ? `\nCallback slot held: ${slot.start}` : ""}`;
          const m = await providers.slack!.postMessage(input.escalationChannel, text);
          return { ref: m.ts, detail: { channel: m.channel } };
        },
      });
      if (slot) {
        actions.push({
          id: "calendar.hold_callback",
          kind: "calendar.hold_callback",
          provider: "calendar",
          agent: "callback-availability",
          gate: "auto",
          summary: { calendarId: input.supportCalendarId, start: slot.start, end: slot.end, attendees: [] },
          async execute({ providers, runId }) {
            // Internal hold only: no attendees, no invitations go out.
            const ev = await providers.calendar!.insertEvent(
              input.supportCalendarId,
              { summary: `Callback: ticket #${ticketId}`, description: c.brief, start: slot.start, end: slot.end, privateKey: `${runId}:hold` },
              "none",
            );
            return { ref: ev.id, detail: { start: slot.start } };
          },
          async reconcile({ providers }, receipt) {
            const ev = await providers.calendar!.getEvent(input.supportCalendarId, receipt.ref);
            return ev.status === "cancelled" ? { status: "missing", detail: "event cancelled" } : { status: "match" };
          },
        });
      }
    }

    actions.push({
      id: "gmail.draft_reply",
      kind: "gmail.draft_reply",
      provider: "gmail",
      agent: "reply-composer",
      gate: "auto",
      summary: { to: input.ticket.requester.email, subject: c.reply.subject, draftedBy: c.reply.draftedBy, sent: false },
      async execute({ providers, runId }) {
        const d = await providers.gmail!.createDraft({ to: input.ticket.requester.email, subject: c.reply.subject, body: c.reply.body, messageId: messageId(runId, "reply") });
        return { ref: d.id };
      },
    });

    actions.push({
      id: "zendesk.public_reply",
      kind: "zendesk.public_reply",
      provider: "zendesk",
      agent: "reply-composer",
      gate: "approval",
      summary: { ticketId, to: input.ticket.requester.email, subject: c.reply.subject, preview: c.reply.body.slice(0, 280) },
      async execute({ providers }) {
        const tk = await providers.zendesk!.updateTicket(ticketId, { comment: { body: c.reply.body, public: true } });
        return { ref: String(tk?.id ?? ticketId) };
      },
    });
    return actions;
  },

  output({ input }, results) {
    const c = out<Composed>(results, "reply-composer");
    const t = out<Triage>(results, "ticket-triage");
    return {
      ticketId: input.ticket.id,
      severity: c?.severity ?? "unknown",
      category: t?.category ?? "unknown",
      escalated: c?.escalate ?? false,
      reasons: c?.reasons ?? [],
      brief: c?.brief ?? "",
      replyDraftedBy: c?.reply.draftedBy ?? "none",
      ticketSource: t?.source ?? "unknown",
    };
  },

  catalog: [
    { kind: "zendesk.annotate_ticket", provider: "zendesk", gate: "auto", description: "Set priority and tags; add an internal note with the account brief" },
    { kind: "slack.post_escalation", provider: "slack", gate: "auto", description: "Post the escalation to the support escalation channel (high/urgent only)" },
    { kind: "calendar.hold_callback", provider: "calendar", gate: "auto", description: "Hold a callback slot on the support lead's calendar (no attendees)" },
    { kind: "gmail.draft_reply", provider: "gmail", gate: "auto", description: "Create (not send) a Gmail draft of the customer reply" },
    { kind: "zendesk.public_reply", provider: "zendesk", gate: "approval", description: "Post the reply publicly on the ticket" },
  ],
};
