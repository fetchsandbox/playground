import { z } from "zod";
import { firstFreeSlot, type Slot } from "../providers/google";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { Approvers, ChannelId, Email, messageId, out, shortHash } from "./shared";

// Customer Success org · cs-ops team.
// Trigger: weekly schedule with the CSM's book of business.

const Input = z.object({
  accounts: z
    .array(z.object({ email: Email, name: z.string().max(200).optional() }))
    .min(1)
    .max(50)
    .refine((a) => new Set(a.map((x) => x.email)).size === a.length, "duplicate account emails"),
  csChannel: ChannelId,
  csmCalendarId: z.string().min(1).default("primary"),
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

interface BillingSignal {
  email: string;
  found: boolean;
  pastDue: boolean;
  cancelling: boolean;
  canceled: boolean;
  openInvoices: number;
}
interface EngagementSignal {
  email: string;
  inCrm: boolean;
  lifecycle?: string;
}
interface SupportSignal {
  email: string;
  open: number;
  urgent: number;
}
interface InboxSignal {
  email: string;
  messages30d: number;
}

export type Tier = "high" | "medium" | "low";
export interface Score {
  email: string;
  name?: string;
  score: number;
  tier: Tier;
  reasons: string[];
  /** Signals we could not read for this account. A low score with gaps is not "safe". */
  unknown: string[];
}

/** Pure scoring. Weights are deliberately simple and documented in the README. */
export function scoreAccount(
  email: string,
  b: BillingSignal | undefined,
  e: EngagementSignal | undefined,
  s: SupportSignal | undefined,
  i: InboxSignal | undefined,
): Omit<Score, "name"> {
  let score = 0;
  const reasons: string[] = [];
  const unknown: string[] = [];
  const add = (n: number, why: string) => {
    score += n;
    reasons.push(`+${n} ${why}`);
  };
  if (!b) unknown.push("billing");
  else {
    if (b.canceled) add(50, "subscription canceled");
    else if (b.cancelling) add(50, "set to cancel at period end");
    if (b.pastDue) add(40, "payment past due");
    if (b.openInvoices) add(Math.min(20, 10 * b.openInvoices), `${b.openInvoices} open invoice(s)`);
  }
  if (!e) unknown.push("crm");
  else if (!e.inCrm) add(10, "no CRM record");
  if (!s) unknown.push("support");
  else {
    if (s.urgent) add(Math.min(40, 20 * s.urgent), `${s.urgent} urgent ticket(s)`);
    if (s.open >= 3) add(10, `${s.open} open tickets`);
  }
  if (!i) unknown.push("inbox");
  else if (i.messages30d === 0) add(10, "no email from the account in 30 days");
  const tier: Tier = score >= 50 ? "high" : score >= 25 ? "medium" : "low";
  return { email, score, tier, reasons, unknown };
}

function perAccount<T>(input: Input, fn: (email: string) => Promise<T>): Promise<T[]> {
  return Promise.all(input.accounts.map((a) => fn(a.email)));
}

export const churnRiskSweep: WorkflowDef<Input> = {
  id: "churn-risk-sweep",
  title: "Churn-risk sweep",
  org: "Customer Success",
  team: "cs-ops",
  description:
    "Score each account's churn risk from Stripe billing, HubSpot engagement, Zendesk tickets and inbox activity; post a digest, draft check-in emails for high-risk accounts and propose QBR invites for approval.",
  input: Input,
  agents: [
    {
      name: "billing-signal",
      needs: ["stripe"],
      async run({ input, providers }) {
        const stripe = providers.stripe!;
        const data = await perAccount(input, async (email): Promise<BillingSignal> => {
          const c = await stripe.findCustomerByEmail(email);
          if (!c) return { email, found: false, pastDue: false, cancelling: false, canceled: false, openInvoices: 0 };
          const [subs, canceled, invoices] = await Promise.all([stripe.listSubscriptions(c.id), stripe.listCanceledSubscriptions(c.id), stripe.listInvoices(c.id, "open")]);
          const live = subs.filter((s) => s.customer === c.id && s.status !== "canceled" && s.status !== "incomplete_expired");
          return {
            email,
            found: true,
            pastDue: live.some((s) => s.status === "past_due" || s.status === "unpaid"),
            cancelling: live.some((s) => s.cancel_at_period_end),
            canceled: live.length === 0 && canceled.some((s) => s.customer === c.id),
            openInvoices: invoices.filter((x) => x.customer === c.id && x.status === "open").length,
          };
        });
        return { summary: `${data.filter((d) => d.pastDue).length} past due, ${data.filter((d) => d.cancelling || d.canceled).length} cancelling`, data };
      },
    },
    {
      name: "engagement-signal",
      needs: ["hubspot"],
      async run({ input, providers }) {
        const data = await perAccount(input, async (email): Promise<EngagementSignal> => {
          const c = await providers.hubspot!.findByEmail(email);
          return { email, inCrm: !!c, lifecycle: c?.properties.lifecyclestage ?? undefined };
        });
        return { summary: `${data.filter((d) => d.inCrm).length}/${data.length} in HubSpot`, data };
      },
    },
    {
      name: "support-signal",
      needs: ["zendesk"],
      async run({ input, providers }) {
        const data = await perAccount(input, async (email): Promise<SupportSignal> => {
          const tickets = await providers.zendesk!.searchTickets(`requester:${email} status<solved`, 100);
          return { email, open: tickets.length, urgent: tickets.filter((t) => t.priority === "urgent").length };
        });
        return { summary: `${data.reduce((n, d) => n + d.urgent, 0)} urgent open tickets`, data };
      },
    },
    {
      name: "inbox-signal",
      needs: ["gmail"],
      async run({ input, providers }) {
        const data = await perAccount(input, async (email): Promise<InboxSignal> => ({ email, messages30d: await providers.gmail!.countMessages(`from:${email} newer_than:30d`) }));
        return { summary: `${data.filter((d) => d.messages30d === 0).length} silent for 30d`, data };
      },
    },
    {
      name: "csm-availability",
      needs: ["calendar"],
      async run({ input, providers, startedAt }) {
        const busy = await providers.calendar!.busy(input.csmCalendarId, startedAt.toISOString(), new Date(startedAt.getTime() + 14 * 86_400_000).toISOString());
        // One distinct 45-minute slot per account, so parallel QBR invites never collide.
        const slots: Slot[] = [];
        for (let k = 0; k < input.accounts.length; k++) {
          const s = firstFreeSlot([...busy, ...slots], startedAt, 45, 10);
          if (!s) break;
          slots.push(s);
        }
        return { summary: `${slots.length} QBR slots available`, data: { slots } };
      },
    },
  ],

  compose: {
    name: "risk-scorer",
    async run({ input, drafter }, results) {
      const find = <T extends { email: string }>(name: string, email: string) => out<T[]>(results, name)?.find((x) => x.email === email);
      const scores: Score[] = input.accounts.map((a) => ({
        name: a.name,
        ...scoreAccount(a.email, find<BillingSignal>("billing-signal", a.email), find<EngagementSignal>("engagement-signal", a.email), find<SupportSignal>("support-signal", a.email), find<InboxSignal>("inbox-signal", a.email)),
      }));
      const high = scores.filter((s) => s.tier === "high");
      const drafts = await Promise.all(
        high.map(async (s) => {
          const first = s.name?.split(" ")[0] ?? "there";
          const d = await drafter.draft({
            task: "churn-checkin",
            instructions: "Draft a short, warm check-in from the customer's success manager offering a quarterly business review. Do not mention risk scores, internal signals or overdue payments.",
            facts: { customerFirstName: first },
            fallback: { subject: "Quick check-in from ACME", body: `Hi ${first},\n\nI'd love to hear how things are going and walk through your goals for next quarter. Would a 45-minute review in the next couple of weeks work? I'll send a proposed time.\n\nBest,\nYour ACME success manager` },
          });
          return { email: s.email, ...d };
        }),
      );
      return { summary: `${high.length} high, ${scores.filter((s) => s.tier === "medium").length} medium`, data: { scores, drafts } };
    },
  },

  plan({ input }, results) {
    const scored = out<{ scores: Score[]; drafts: { email: string; subject: string; body: string; draftedBy: string }[] }>(results, "risk-scorer");
    if (!scored) return [];
    const slots = out<{ slots: Slot[] }>(results, "csm-availability")?.slots ?? [];
    const flagged = scored.scores.filter((s) => s.tier !== "low");
    const actions: PlannedAction<Input>[] = [];
    if (flagged.length) {
      const text = [
        `*Churn-risk sweep* — ${flagged.filter((s) => s.tier === "high").length} high, ${flagged.filter((s) => s.tier === "medium").length} medium of ${scored.scores.length} accounts.`,
        ...flagged.sort((a, b) => b.score - a.score).map((s) => `• ${s.tier.toUpperCase()} ${s.email} (${s.score}): ${s.reasons.join(", ")}${s.unknown.length ? ` — unknown: ${s.unknown.join(", ")}` : ""}`),
      ].join("\n");
      actions.push({
        id: "slack.post_digest",
        kind: "slack.post_digest",
        provider: "slack",
        agent: "risk-scorer",
        gate: "auto",
        summary: { channel: input.csChannel, flagged: flagged.length },
        async execute({ providers }) {
          const m = await providers.slack!.postMessage(input.csChannel, text);
          return { ref: m.ts, detail: { channel: m.channel } };
        },
      });
    }
    scored.scores
      .filter((s) => s.tier === "high")
      .forEach((s, idx) => {
        const key = shortHash(s.email);
        const draft = scored.drafts.find((d) => d.email === s.email);
        if (draft) {
          actions.push({
            id: `gmail.draft_checkin:${key}`,
            kind: "gmail.draft_checkin",
            provider: "gmail",
            agent: "risk-scorer",
            gate: "auto",
            summary: { to: s.email, subject: draft.subject, draftedBy: draft.draftedBy, sent: false },
            async execute({ providers, runId }) {
              const d = await providers.gmail!.createDraft({ to: s.email, subject: draft.subject, body: draft.body, messageId: messageId(runId, `checkin-${key}`) });
              return { ref: d.id };
            },
          });
        }
        const slot = slots[idx];
        if (slot) {
          actions.push({
            id: `calendar.book_qbr:${key}`,
            kind: "calendar.book_qbr",
            provider: "calendar",
            agent: "csm-availability",
            gate: "approval",
            summary: { attendee: s.email, start: slot.start, end: slot.end, calendarId: input.csmCalendarId, sendsInvite: true },
            async execute({ providers, runId }) {
              const ev = await providers.calendar!.insertEvent(
                input.csmCalendarId,
                { summary: "ACME quarterly business review", description: "Agenda: goals, adoption, roadmap, open questions.", start: slot.start, end: slot.end, attendees: [s.email], privateKey: `${runId}:qbr:${key}` },
                "all",
              );
              return { ref: ev.id, detail: { start: slot.start } };
            },
            async reconcile({ providers }, receipt) {
              const ev = await providers.calendar!.getEvent(input.csmCalendarId, receipt.ref);
              const ok = ev.status !== "cancelled" && (ev.attendees ?? []).some((a) => a.email?.toLowerCase() === s.email);
              return ok ? { status: "match" } : { status: "drift", detail: "event cancelled or attendee removed" };
            },
          });
        }
      });
    return actions;
  },

  output(_ctx, results) {
    const scored = out<{ scores: Score[] }>(results, "risk-scorer");
    const scores = scored?.scores ?? [];
    return {
      accounts: scores.length,
      high: scores.filter((s) => s.tier === "high").length,
      medium: scores.filter((s) => s.tier === "medium").length,
      low: scores.filter((s) => s.tier === "low").length,
      signalGaps: [...new Set(scores.flatMap((s) => s.unknown))].sort(),
      scores,
    };
  },

  catalog: [
    { kind: "slack.post_digest", provider: "slack", gate: "auto", description: "Post the risk digest to the CS channel (only when something is medium/high)" },
    { kind: "gmail.draft_checkin", provider: "gmail", gate: "auto", description: "Create (not send) a check-in draft for each high-risk account" },
    { kind: "calendar.book_qbr", provider: "calendar", gate: "approval", description: "Invite a high-risk account to a QBR on the CSM's calendar (sends an invitation)" },
  ],
};
