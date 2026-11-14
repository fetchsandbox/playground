import { z } from "zod";
import { ProviderError, SkipAction } from "../kit/errors";
import type { ActionReceipt, PlannedAction, WorkflowDef } from "../kit/types";
import { ChannelId, Email, messageId, out, plain } from "./shared";

// Sales · sales-ops.
// Trigger: a web form submits a lead (leadId + name + email).
// Reliable follow-up without duplicate Deals, duplicate emails or silent failures:
//   1. find or create the HubSpot contact and its sales Deal (keyed by leadId);
//   2. send the follow-up through Gmail (Message-ID natural key; timeout → reconcile);
//   3. if delivery is unresolved, three confirmation lookups over the window;
//   4. create a Calendar event only after email success is confirmed;
//   5. Slack the team on completion or hand off a blocked step with instructions.

/** Default: three lookups evenly spaced across 30 minutes. Overridable for proofs. */
export const POLICY = {
  confirmLookups: 3,
  confirmWindowMs: Number(process.env.LEAD_FOLLOWUP_CONFIRM_WINDOW_MS ?? 30 * 60_000),
  meetingMinutes: 30,
  dealStage: "appointmentscheduled",
  pipeline: "default",
} as const;

const Name = z.string().trim().min(1).max(200);
const Input = z.object({
  leadId: z.string().trim().min(1).max(100),
  name: Name,
  email: Email,
  salesChannel: ChannelId,
  calendarId: z.string().min(1).default("primary"),
  /** Optional override for twin proofs (milliseconds). */
  confirmWindowMs: z.number().int().min(0).max(24 * 60 * 60_000).optional(),
});
type Input = z.infer<typeof Input>;

interface CrmState {
  contactId?: string;
  existingDealId?: string;
  dealname: string;
}

interface FollowUpCopy {
  subject: string;
  body: string;
  draftedBy: string;
}

const dealName = (leadId: string) => `Lead follow-up ${leadId}`;
const midFor = (leadId: string) => messageId(leadId, "lead-followup");

function confirmDelaysMs(windowMs: number): number[] {
  const n = POLICY.confirmLookups;
  if (windowMs <= 0) return Array.from({ length: n }, () => 0);
  return Array.from({ length: n }, (_, i) => Math.round(((i + 1) / n) * windowMs));
}

function emailConfirmed(applied: Record<string, ActionReceipt>): boolean {
  const send = applied["gmail.send_followup"];
  if (send?.detail?.confirmed === true) return true;
  for (let i = 1; i <= POLICY.confirmLookups; i++) {
    if (applied[`gmail.confirm_lookup:${i}`]?.detail?.found === true) return true;
  }
  return false;
}

function isUnknownTransport(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  return err.code === "network" || err.status === 0;
}

function splitName(name: string): { firstname: string; lastname?: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { firstname: parts[0]! };
  return { firstname: parts[0]!, lastname: parts.slice(1).join(" ") };
}

export const leadFollowUp: WorkflowDef<Input> = {
  id: "lead-follow-up",
  title: "Lead follow-up",
  org: "Sales",
  team: "sales-ops",
  description:
    "On form submit: find or create the HubSpot contact and sales Deal, send a Gmail follow-up, confirm delivery (three lookups over 30 minutes when unresolved), create a Calendar event only after email success, and notify Slack on completion or a blocked handoff.",
  input: Input,
  tickEvery: "rate(1 minute)",
  agents: [
    {
      name: "crm-check",
      needs: ["hubspot"],
      async run({ input, providers }) {
        const dealname = dealName(input.leadId);
        const [contact, deal] = await Promise.all([providers.hubspot!.findByEmail(input.email), providers.hubspot!.findDealByName(dealname)]);
        const data: CrmState = { contactId: contact?.id, existingDealId: deal?.id, dealname };
        return {
          summary: `${contact ? `contact ${contact.id}` : "new contact"}; ${deal ? `deal ${deal.id}` : "new deal"}`,
          data,
        };
      },
    },
  ],

  compose: {
    name: "followup-composer",
    async run({ input, drafter }) {
      const first = splitName(input.name).firstname;
      const d = await drafter.draft({
        task: "lead-followup-email",
        instructions: "Draft a short sales follow-up email after a web form submission: thank them, confirm we received their interest, offer a brief intro call, and keep it under 120 words. Do not invent product claims or pricing.",
        facts: { firstName: first, leadId: input.leadId },
        fallback: {
          subject: `Thanks for reaching out, ${plain(first, 40)}`,
          body: `Hi ${first},\n\nThanks for your interest in ACME. We received your request (${input.leadId}) and a specialist will follow up shortly. If a quick intro call would help, reply with a couple of times that work this week.\n\n— ACME Sales`,
        },
      });
      return { summary: `follow-up drafted by ${d.draftedBy}`, data: d satisfies FollowUpCopy };
    },
  },

  plan({ input }, results) {
    const crm = out<CrmState>(results, "crm-check");
    const copy = out<FollowUpCopy>(results, "followup-composer");
    const actions: PlannedAction<Input>[] = [];
    const windowMs = input.confirmWindowMs ?? POLICY.confirmWindowMs;
    const delays = confirmDelaysMs(windowMs);
    const names = splitName(input.name);
    const mid = midFor(input.leadId);
    const confirmIds = delays.map((_, i) => `gmail.confirm_lookup:${i + 1}`);

    if (!crm) {
      actions.push({
        id: "slack.notify_blocked_step",
        kind: "slack.notify_blocked_step",
        provider: "slack",
        agent: "crm-check",
        gate: "auto",
        summary: { channel: input.salesChannel, leadId: input.leadId, blockedStep: "crm-check" },
        async execute({ providers }) {
          const text = [
            `:warning: Lead follow-up blocked at \`crm-check\` for \`${plain(input.leadId, 60)}\` (${input.email}).`,
            `Instructions: restore HubSpot access, then re-run with the same leadId so contact/Deal creation stay idempotent.`,
          ].join("\n");
          const m = await providers.slack!.postMessage(input.salesChannel, text);
          return { ref: m.ts, detail: { blockedStep: "crm-check" } };
        },
      });
      return actions;
    }

    if (crm) {
      actions.push({
        id: "hubspot.upsert_contact",
        kind: "hubspot.upsert_contact",
        provider: "hubspot",
        agent: "crm-check",
        gate: "auto",
        summary: { email: input.email, existing: crm.contactId ?? null },
        async execute({ providers }) {
          const props: Record<string, string> = { firstname: names.firstname, lifecyclestage: "lead", hs_lead_status: "NEW" };
          if (names.lastname) props.lastname = names.lastname;
          const { contact, created } = await providers.hubspot!.upsertByEmail(input.email, props);
          return { ref: contact.id, detail: { created } };
        },
        async reconcile({ providers }, receipt) {
          const c = await providers.hubspot!.get(receipt.ref);
          return c.properties.email?.toLowerCase() === input.email ? { status: "match" } : { status: "drift", detail: `email is ${c.properties.email}` };
        },
      });

      actions.push({
        id: "hubspot.create_deal",
        kind: "hubspot.create_deal",
        provider: "hubspot",
        agent: "crm-check",
        gate: "auto",
        requires: ["hubspot.upsert_contact"],
        summary: { dealname: crm.dealname, existing: crm.existingDealId ?? null },
        async execute({ providers, applied }) {
          const contactId = applied["hubspot.upsert_contact"]?.ref;
          if (!contactId) throw new SkipAction("no contact");
          // Re-check at write time so a concurrent run's Deal is adopted, never duplicated.
          const { deal, created } = await providers.hubspot!.ensureDeal(
            crm.dealname,
            { dealstage: POLICY.dealStage, pipeline: POLICY.pipeline },
            contactId,
          );
          return { ref: deal.id, detail: { created, dealname: crm.dealname } };
        },
        async reconcile({ providers }, receipt) {
          const d = await providers.hubspot!.getDeal(receipt.ref);
          return d.properties.dealname === crm.dealname ? { status: "match" } : { status: "drift", detail: `dealname is ${d.properties.dealname}` };
        },
      });
    }

    if (copy) {
      actions.push({
        id: "gmail.send_followup",
        kind: "gmail.send_followup",
        provider: "gmail",
        agent: "followup-composer",
        gate: "auto",
        requires: crm ? ["hubspot.create_deal"] : undefined,
        summary: { to: input.email, subject: copy.subject, messageId: mid, sent: true },
        async execute({ providers }) {
          const existing = await providers.gmail!.findByRfc822MessageId(mid);
          if (existing) return { ref: existing.id, detail: { confirmed: true, created: false, messageId: mid } };
          try {
            const sent = await providers.gmail!.sendMessage({ to: input.email, subject: copy.subject, body: copy.body, messageId: mid });
            return { ref: sent.id, detail: { confirmed: true, created: true, messageId: mid } };
          } catch (err) {
            if (!isUnknownTransport(err)) throw err;
            // Timeout / lost response: outcome unknown until an independent lookup.
            let found: { id: string } | undefined;
            try {
              found = await providers.gmail!.findByRfc822MessageId(mid);
            } catch (lookupErr) {
              if (isUnknownTransport(lookupErr)) {
                // Cannot confirm and must not resend: park as unknown for the confirm sequence.
                return { ref: mid, detail: { confirmed: false, outcome: "unknown", messageId: mid, lookup: "unavailable" } };
              }
              throw lookupErr;
            }
            if (found) return { ref: found.id, detail: { confirmed: true, created: true, recovered: true, messageId: mid } };
            return { ref: mid, detail: { confirmed: false, outcome: "unknown", messageId: mid } };
          }
        },
        async reconcile({ providers }, receipt) {
          const midValue = String(receipt.detail?.messageId ?? mid);
          const found = await providers.gmail!.findByRfc822MessageId(midValue);
          if (!found) return receipt.detail?.confirmed ? { status: "missing", detail: "message not in mailbox" } : { status: "unverifiable", detail: "still unresolved" };
          return { status: "match" };
        },
      });
    }

    for (let i = 0; i < delays.length; i++) {
      const id = confirmIds[i]!;
      const n = i + 1;
      actions.push({
        id,
        kind: "gmail.confirm_lookup",
        provider: "gmail",
        agent: "followup-composer",
        gate: "auto",
        requires: ["gmail.send_followup"],
        delayAfter: { action: "gmail.send_followup", ms: delays[i]! },
        summary: { lookup: n, of: delays.length, afterMs: delays[i] },
        async execute({ providers, applied }) {
          if (emailConfirmed(applied)) throw new SkipAction("email already confirmed");
          const midValue = String(applied["gmail.send_followup"]?.detail?.messageId ?? mid);
          let found: { id: string } | undefined;
          try {
            found = await providers.gmail!.findByRfc822MessageId(midValue);
          } catch (err) {
            if (isUnknownTransport(err) || (err instanceof ProviderError && err.retryable)) {
              if (n < delays.length) throw new SkipAction(`lookup ${n} unavailable; will retry`);
              return { ref: midValue, detail: { found: false, lookup: n, unavailable: true } };
            }
            throw err;
          }
          if (found) return { ref: found.id, detail: { found: true, lookup: n, messageId: midValue } };
          if (n < delays.length) throw new SkipAction(`not found on lookup ${n}`);
          return { ref: midValue, detail: { found: false, lookup: n, exhausted: true } };
        },
      });
    }

    actions.push({
      id: "calendar.create_followup",
      kind: "calendar.create_followup",
      provider: "calendar",
      agent: "followup-composer",
      gate: "auto",
      after: ["gmail.send_followup", ...confirmIds],
      summary: { calendarId: input.calendarId, attendee: input.email, gatedOn: "confirmed email" },
      async execute({ providers, applied, runId, startedAt: at }) {
        if (!emailConfirmed(applied)) throw new SkipAction("email not confirmed; calendar withheld");
        const key = `${input.leadId}:followup`;
        const existing = await providers.calendar!.findEventByPrivateKey(input.calendarId, key);
        if (existing) return { ref: existing.id, detail: { created: false } };
        const start = new Date(at.getTime() + 2 * 86_400_000);
        // Next weekday 16:00 UTC.
        while (start.getUTCDay() === 0 || start.getUTCDay() === 6) start.setUTCDate(start.getUTCDate() + 1);
        start.setUTCHours(16, 0, 0, 0);
        const end = new Date(start.getTime() + POLICY.meetingMinutes * 60_000);
        const ev = await providers.calendar!.insertEvent(
          input.calendarId,
          {
            summary: `ACME intro — ${plain(input.name, 80)}`,
            description: `Follow-up for lead ${plain(input.leadId, 60)} (run ${plain(runId, 80)}).`,
            start: start.toISOString(),
            end: end.toISOString(),
            attendees: [input.email],
            privateKey: key,
          },
          "all",
        );
        return { ref: ev.id, detail: { created: true, start: start.toISOString() } };
      },
      async reconcile({ providers }, receipt) {
        const ev = await providers.calendar!.getEvent(input.calendarId, receipt.ref);
        return ev.status === "cancelled" ? { status: "missing", detail: "event cancelled" } : { status: "match" };
      },
    });

    actions.push({
      id: "slack.notify_complete",
      kind: "slack.notify_complete",
      provider: "slack",
      agent: "followup-composer",
      gate: "auto",
      requires: ["calendar.create_followup"],
      summary: { channel: input.salesChannel, leadId: input.leadId },
      async execute({ providers, applied }) {
        const dealRef = applied["hubspot.create_deal"]?.ref ?? "n/a";
        const mailRef = applied["gmail.send_followup"]?.ref ?? "n/a";
        const calRef = applied["calendar.create_followup"]?.ref ?? "n/a";
        const text = [
          `:white_check_mark: Lead follow-up complete for *${plain(input.name, 80)}* (\`${plain(input.leadId, 60)}\`).`,
          `Deal \`${plain(dealRef, 40)}\` · email \`${plain(mailRef, 40)}\` · calendar \`${plain(calRef, 40)}\`.`,
        ].join("\n");
        const m = await providers.slack!.postMessage(input.salesChannel, text);
        return { ref: m.ts, detail: { channel: m.channel } };
      },
    });

    actions.push({
      id: "slack.handoff_blocked",
      kind: "slack.handoff_blocked",
      provider: "slack",
      agent: "followup-composer",
      gate: "auto",
      after: ["gmail.send_followup", ...confirmIds, "calendar.create_followup"],
      summary: { channel: input.salesChannel, leadId: input.leadId, when: "email unresolved" },
      async execute({ providers, applied, statuses }) {
        const calStatus = statuses["calendar.create_followup"];
        if (calStatus === "applied") throw new SkipAction("not blocked");
        if (!calStatus || calStatus === "scheduled" || calStatus === "planned") throw new SkipAction("still in progress");
        const emailOk = emailConfirmed(applied);
        const calFailed = calStatus === "failed";
        const blockedStep = calFailed ? "calendar.create_followup" : statuses["gmail.send_followup"] === "failed" ? "gmail.send_followup" : "gmail.confirm_lookup";
        const instructions = calFailed
          ? `Instructions: 1) Confirm Message-ID \`${plain(mid, 120)}\` is in Sent. 2) Create the intro meeting on \`${plain(input.calendarId, 40)}\` for ${input.email}. 3) Reply in this channel when done.`
          : `Instructions: 1) Open Gmail Sent for Message-ID \`${plain(mid, 120)}\`. 2) If the message exists, mark the run reconciled and create the intro meeting on \`${plain(input.calendarId, 40)}\`. 3) If it does not exist, send one follow-up manually and update HubSpot Deal \`${plain(dealName(input.leadId), 80)}\`. 4) Reply in this channel when done. Do not re-fire the form automation until the mailbox is checked — a blind retry can double-email.`;
        const text = [
          `:rotating_light: *Lead follow-up blocked* — needs a person.`,
          `Lead: *${plain(input.name, 80)}* · ${input.email} · id \`${plain(input.leadId, 60)}\`.`,
          `Blocked step: \`${blockedStep}\`${emailOk ? " (email confirmed; downstream step failed)" : ` (email delivery unresolved after ${POLICY.confirmLookups} lookups over ${Math.round(windowMs / 60_000)} min)`}.`,
          instructions,
        ].join("\n");
        const m = await providers.slack!.postMessage(input.salesChannel, text);
        return { ref: m.ts, detail: { channel: m.channel, blockedStep } };
      },
    });

    // Surface provider failures that stop the pipeline before confirms.
    actions.push({
      id: "slack.notify_blocked_step",
      kind: "slack.notify_blocked_step",
      provider: "slack",
      agent: "crm-check",
      gate: "auto",
      after: ["hubspot.upsert_contact", "hubspot.create_deal", "gmail.send_followup"],
      summary: { channel: input.salesChannel, leadId: input.leadId },
      async execute({ providers, statuses }) {
        const order = ["hubspot.upsert_contact", "hubspot.create_deal", "gmail.send_followup"] as const;
        const failed = order.find((id) => statuses[id] === "failed");
        if (!failed) throw new SkipAction("no early failure");
        if (failed === "gmail.send_followup") throw new SkipAction("email path uses confirmation handoff");
        const text = [
          `:warning: Lead follow-up blocked at \`${failed}\` for \`${plain(input.leadId, 60)}\` (${input.email}).`,
          `Instructions: fix the ${failed.startsWith("hubspot") ? "HubSpot" : "provider"} issue, then re-run with the same leadId so Deal/email stay idempotent.`,
        ].join("\n");
        const m = await providers.slack!.postMessage(input.salesChannel, text);
        return { ref: m.ts, detail: { blockedStep: failed } };
      },
    });

    return actions;
  },

  output({ input }, results) {
    const crm = out<CrmState>(results, "crm-check");
    return {
      leadId: input.leadId,
      email: input.email,
      dealname: crm?.dealname ?? dealName(input.leadId),
      confirmWindowMs: input.confirmWindowMs ?? POLICY.confirmWindowMs,
    };
  },

  catalog: [
    { kind: "hubspot.upsert_contact", provider: "hubspot", gate: "auto", description: "Find or create the HubSpot contact for the lead email" },
    { kind: "hubspot.create_deal", provider: "hubspot", gate: "auto", description: "Create the sales Deal keyed by leadId, or adopt the existing one" },
    { kind: "gmail.send_followup", provider: "gmail", gate: "auto", description: "Send the follow-up email (Message-ID keyed; timeout reconciles before any retry)" },
    { kind: "gmail.confirm_lookup", provider: "gmail", gate: "auto", description: "Confirmation lookup toward unresolved email delivery (three over the window)" },
    { kind: "calendar.create_followup", provider: "calendar", gate: "auto", description: "Create the intro Calendar event only after email success is confirmed" },
    { kind: "slack.notify_complete", provider: "slack", gate: "auto", description: "Notify the sales channel that follow-up completed" },
    { kind: "slack.handoff_blocked", provider: "slack", gate: "auto", description: "Hand off unresolved email delivery to a person with lead details and instructions" },
    { kind: "slack.notify_blocked_step", provider: "slack", gate: "auto", description: "Notify the sales channel when HubSpot (or an early step) fails" },
  ],
};
