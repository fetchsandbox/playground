import { createHash } from "node:crypto";
import { z } from "zod";
import { errorCode, errorMessage, FatalError, ProviderError, RetryLater } from "../kit/errors";
import type { ActionContext, ActionReceipt, PlannedAction, WorkflowDef } from "../kit/types";
import type { HubSpotDeal } from "../providers/hubspot";
import { ChannelId, Email, plain, shortHash } from "./shared";

// Inbound lead follow-up · Sales / sales-team.
// Trigger: a web form submits {leadId, name, email}. The lead ID is the run's
// identity, so every resubmission of a lead joins the one durable run.
//
//   hubspot.contact ─► hubspot.deal ─► gmail.send_followup ─► calendar.followup_event
//                                                                       │
//                         slack.notify_team (completion, or blocked-step handoff) ◄┘
//
// Every write is reconcile-first and never blindly repeated: it first looks for
// the effect by a key derived from the lead (email, deal name token, RFC
// Message-ID, calendar event id, Slack marker); a timeout or 5xx means the
// outcome is unknown, so the step reads provider state back and, if still
// unresolved, is re-checked later (RetryLater), not re-sent.

const LeadId = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/, "lead ID: 1-80 letters, digits, '-' or '_'");
const SlackUser = z.string().regex(/^[UW][A-Z0-9]{2,}$/, "Slack user id like U0123ABCD");

const Input = z
  .object({
    leadId: LeadId,
    name: z.string().trim().min(1).max(200),
    email: Email,
    /** Team channel. Defaults to LEAD_FOLLOWUP_SLACK_CHANNEL. */
    salesChannel: ChannelId.optional(),
    /** Person who takes over a blocked lead. Defaults to LEAD_FOLLOWUP_OWNER_SLACK_ID. */
    handoffUserId: SlackUser.optional(),
    calendarId: z.string().min(1).max(200).default("primary"),
  })
  .superRefine((v, ctx) => {
    const channel = v.salesChannel ?? process.env.LEAD_FOLLOWUP_SLACK_CHANNEL;
    if (!channel || !ChannelId.safeParse(channel).success) {
      ctx.addIssue({ code: "custom", path: ["salesChannel"], message: "a Slack channel id is required (input.salesChannel or LEAD_FOLLOWUP_SLACK_CHANNEL)" });
    }
  });
type Input = z.infer<typeof Input>;

// ---------------------------------------------------------------------------
// Configuration (deployment env; the defaults are the production policy)
// ---------------------------------------------------------------------------

const num = (name: string, dflt: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
/** Gap between email confirmation lookups: initial, +15 min, +30 min (agreed schedule). */
const confirmIntervalMs = () => num("LEAD_EMAIL_CONFIRM_INTERVAL_MS", 15 * 60_000);
/** Timeout for reconciliation reads, which are safe to wait on longer than a write. */
const reconcileReadTimeoutMs = () => num("LEAD_RECONCILE_READ_TIMEOUT_MS", 15_000);
export const EMAIL_CONFIRMATION_LOOKUPS = 3;
/** Re-check delay after an unknown or refused HubSpot / Calendar / Slack write. */
const retryIntervalMs = () => num("LEAD_RETRY_INTERVAL_MS", 2 * 60_000);
/** Attempts per step (each one reconciles first) before a person takes over. */
const maxAttempts = () => num("LEAD_MAX_ATTEMPTS", 3);
const channelOf = (i: Input) => (i.salesChannel ?? process.env.LEAD_FOLLOWUP_SLACK_CHANNEL)!;
const handoffOf = (i: Input) => i.handoffUserId ?? (SlackUser.safeParse(process.env.LEAD_FOLLOWUP_OWNER_SLACK_ID).success ? process.env.LEAD_FOLLOWUP_OWNER_SLACK_ID : undefined);

// ---------------------------------------------------------------------------
// Identities derived from the lead: the reconciliation keys
// ---------------------------------------------------------------------------

export const dealName = (i: Pick<Input, "leadId" | "name">) => `Lead ${i.leadId} · ${plain(i.name, 120)}`;
/** One deal per lead: its name starts with "Lead <leadId> ". */
const isLeadDeal = (d: HubSpotDeal, leadId: string) => String(d.properties.dealname ?? "").startsWith(`Lead ${leadId} `);
/** RFC 5322 Message-ID of the one follow-up email for this lead (Gmail search: rfc822msgid:). */
export const followUpMessageId = (leadId: string) => `<lead-${shortHash("lead-follow-up", leadId)}@ops.acme.example>`;
/** Google Calendar event id (base32hex: 0-9 a-v) of the one follow-up call for this lead. */
export const followUpEventId = (leadId: string) => `lf${createHash("sha256").update(`lead-follow-up\u0000${leadId}`).digest("hex").slice(0, 30)}`;
/** Marker carried by the one Slack notification for this lead. */
export const slackMarker = (leadId: string) => `[lead-followup ${leadId}]`;

/** Follow-up call: next business day after submission, 30 minutes at LEAD_FOLLOWUP_HOUR_UTC (default 16:00 UTC). */
export function followUpSlot(submittedAt: Date): { start: string; end: string } {
  const hour = Math.min(23, Math.max(0, Math.trunc(num("LEAD_FOLLOWUP_HOUR_UTC", 16))));
  const d = new Date(Date.UTC(submittedAt.getUTCFullYear(), submittedAt.getUTCMonth(), submittedAt.getUTCDate(), hour));
  do d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return { start: d.toISOString(), end: new Date(d.getTime() + 30 * 60_000).toISOString() };
}

function nameProps(name: string): Record<string, string> {
  const [first, ...rest] = name.trim().split(/\s+/);
  return rest.length ? { firstname: first!, lastname: rest.join(" ") } : { firstname: first! };
}

/** Slack mrkdwn: escape the three control characters; keep emails intact. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------------------------------------------------------------------------
// Failure taxonomy
// ---------------------------------------------------------------------------

/** The provider may have applied the write: timeout, dropped connection, 5xx. */
export function ambiguous(err: unknown): boolean {
  return err instanceof ProviderError && (err.status === 0 || err.status >= 500);
}

/** Retrying cannot help without a person (credentials, configuration, bad request). */
function permanent(err: unknown): boolean {
  if (err instanceof FatalError) return true;
  if (!(err instanceof ProviderError)) return false;
  if (err.code === "spec_deviation" || err.code === "write_not_verified") return true;
  if (err.provider === "slack" && err.status === 200) return err.code !== "ratelimited";
  return [400, 401, 404, 422].includes(err.status);
}

interface Blocked {
  code: string;
  message: string;
  attempts: number;
  /** Gmail only: the send outcome stayed unknown through every confirmation lookup. */
  unconfirmed?: boolean;
}

type Ctx = ActionContext<Input>;

/**
 * Runs one attempt of a step. A transient or ambiguous failure becomes a
 * scheduled re-check (the next attempt reconciles first); a permanent one, or
 * the last attempt, fails the step and records why for the Slack handoff.
 */
async function attempt<T>(ctx: Ctx, step: string, fn: () => Promise<T>): Promise<T> {
  const n = ((await ctx.checkpoint.load<number>(`attempts:${step}`)) ?? 0) + 1;
  await ctx.checkpoint.save(`attempts:${step}`, n);
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RetryLater) throw err;
    const provider = err instanceof ProviderError ? err.provider : "app";
    if (!permanent(err) && n < maxAttempts()) {
      const what = ambiguous(err) ? "outcome unknown" : "not accepted";
      throw new RetryLater(retryIntervalMs(), `${what} (${errorMessage(err)}); attempt ${n}/${maxAttempts()}, re-checking before any repeat`, ambiguous(err) ? `${provider}:outcome_unknown` : errorCode(err));
    }
    await ctx.checkpoint.save(`blocked:${step}`, { code: errorCode(err), message: errorMessage(err), attempts: n } satisfies Blocked);
    throw err;
  }
}

/**
 * Find-before-write with a write-ahead marker. While the marker says a write
 * may have happened, a failed lookup is not treated as "absent" and nothing is
 * written. After an ambiguous write the effect is read back once immediately;
 * if that cannot confirm it, the error propagates (and `attempt` re-checks later).
 */
async function reconcileThenWrite<T>(
  ctx: Ctx,
  step: string,
  find: () => Promise<T | undefined>,
  write: () => Promise<T>,
  /** false when the lookup is eventually consistent (HubSpot CRM search): reconcile on the next attempt, not immediately. */
  readbackNow = true,
): Promise<{ value: T; created: boolean; via: "lookup" | "write" | "readback" }> {
  const key = `write:${step}`;
  const pending = (await ctx.checkpoint.load<string>(key)) === "unknown";
  let found: T | undefined;
  try {
    found = await find();
  } catch (err) {
    if (pending) throw err; // cannot rule out our earlier write: do not write again
  }
  if (found !== undefined) return { value: found, created: pending, via: "lookup" };
  await ctx.checkpoint.save(key, "unknown");
  try {
    const value = await write();
    await ctx.checkpoint.save(key, "done");
    return { value, created: true, via: "write" };
  } catch (err) {
    if (!ambiguous(err)) {
      await ctx.checkpoint.save(key, "clean"); // refused: nothing was written
      throw err;
    }
    if (readbackNow) {
      const again = await find().catch(() => undefined);
      if (again !== undefined) return { value: again, created: true, via: "readback" };
    }
    throw err; // still unknown: `attempt` schedules the re-check, which looks before any repeat
  }
}

// ---------------------------------------------------------------------------
// The email: one send; if its outcome is unknown, an initial lookup and then
// lookups 15 and 30 minutes after the send; never a resend
// ---------------------------------------------------------------------------

interface EmailState {
  /** unsent: no send attempt can have been accepted. unknown: a send may have been accepted. */
  phase: "unsent" | "unknown";
  sendAttempts: number;
  /** When the send whose outcome is unknown was made: the lookup schedule is anchored here. */
  sentAt?: string;
  lookups: number;
  /** "+0.1 min failed (gmail:503)", "+15.0 min not found"... one entry per confirmation lookup. */
  lookupLog: string[];
}

export function followUpEmail(i: Input) {
  const first = plain(i.name, 80).split(" ")[0] || "there";
  return {
    to: i.email,
    subject: "Thanks for reaching out to ACME",
    body: `Hi ${first},\n\nThanks for your interest in ACME. A member of our sales team will contact you within one business day to learn what you need and answer your questions.\n\nIf there is a better time or number to reach you, just reply to this email.\n\nThe ACME sales team`,
    messageId: followUpMessageId(i.leadId),
  };
}

/** Minutes after the send at which confirmation lookup k (1-based) is due: 0, 15, 30 by default. */
export const lookupOffsetMs = (k: number) => (k - 1) * confirmIntervalMs();

type Lookup = { found?: { id: string; duplicates: number }; error?: unknown };

/** The follow-up in the mailbox by its Message-ID, read back by id; SENT is Gmail's confirmation it went out. */
async function lookUp(ctx: Ctx, messageId: string): Promise<Lookup> {
  try {
    const ids = await ctx.providers.gmail!.findByMessageId(messageId);
    if (!ids.length) return {};
    const msg = await ctx.providers.gmail!.getMessage(ids[0]!);
    if (msg.labelIds.includes("SENT")) return { found: { id: msg.id, duplicates: ids.length - 1 } };
    return { error: new ProviderError("gmail", 200, "not_sent_label", true, `message ${msg.id} has no SENT label`) };
  } catch (err) {
    return { error: err };
  }
}

async function sendFollowUp(ctx: Ctx): Promise<ActionReceipt> {
  const { input, providers, checkpoint } = ctx;
  const messageId = followUpMessageId(input.leadId);
  const saved = await checkpoint.load<EmailState>("email");
  const st: EmailState = { phase: "unsent", sendAttempts: 0, lookups: 0, ...saved, lookupLog: saved?.lookupLog ?? [] };

  if (st.phase === "unsent") {
    // Reconcile first: is the follow-up already in the mailbox? (A failed lookup here cannot hide
    // a send of ours: none can have been accepted while the phase is "unsent".)
    const pre = await lookUp(ctx, messageId);
    if (pre.found) return { ref: pre.found.id, detail: { state: "confirmed", confirmedBy: "existing message", messageId, sendAttempts: st.sendAttempts, lookups: 0 } };

    // Send once. Mark the outcome unknown first, so a crash mid-send counts as "maybe sent".
    st.phase = "unknown";
    st.sendAttempts += 1;
    st.sentAt = new Date(ctx.now()).toISOString();
    st.lookups = 0;
    st.lookupLog = [];
    await checkpoint.save("email", st);
    ctx.log.info("gmail send dispatched", { leadId: input.leadId, messageId });
    try {
      const sent = await providers.gmail!.sendOnce(followUpEmail(input));
      if (!sent.labelIds.includes("SENT")) throw new ProviderError("gmail", 200, "not_sent_label", true, "send answered without the SENT label");
      return { ref: sent.id, detail: { state: "confirmed", confirmedBy: "send response", messageId, sendAttempts: st.sendAttempts, lookups: 0 } };
    } catch (err) {
      if (!ambiguous(err) && !(err instanceof ProviderError && err.code === "not_sent_label")) {
        // Refused (403, 429, 401...): Gmail did not accept it, nothing was sent.
        st.phase = "unsent";
        delete st.sentAt;
        await checkpoint.save("email", st);
        if (!permanent(err) && st.sendAttempts < maxAttempts()) {
          throw new RetryLater(retryIntervalMs(), `Gmail refused the send (${errorCode(err)}); nothing was sent; attempt ${st.sendAttempts}/${maxAttempts()}`, errorCode(err));
        }
        await checkpoint.save("blocked:gmail.send_followup", { code: errorCode(err), message: errorMessage(err), attempts: st.sendAttempts } satisfies Blocked);
        throw err;
      }
      // Timeout / 5xx: the outcome is unknown. Fall through to the initial confirmation lookup now.
    }
  }

  // The send may have been accepted: confirmation lookup k of 3 (initial, +15 min, +30 min). Never resend.
  const k = st.lookups + 1;
  const sentAt = Date.parse(st.sentAt ?? new Date(ctx.now()).toISOString());
  const after = `+${((ctx.now() - sentAt) / 60_000).toFixed(1)} min`;
  const r = await lookUp(ctx, messageId);
  st.lookups = k;
  st.lookupLog = [...st.lookupLog, `${after} ${r.found ? "found" : r.error ? `failed (${errorCode(r.error)})` : "not found"}`];
  await checkpoint.save("email", st);
  if (r.found) {
    return { ref: r.found.id, detail: { state: "confirmed", confirmedBy: `confirmation lookup ${k}/${EMAIL_CONFIRMATION_LOOKUPS}`, confirmedAfter: after, lookupSchedule: st.lookupLog.join("; "), messageId, sendAttempts: st.sendAttempts, lookups: k, duplicates: r.found.duplicates } };
  }
  if (k >= EMAIL_CONFIRMATION_LOOKUPS) {
    const message = `Gmail did not confirm the follow-up email after ${k} lookups (${st.lookupLog.join("; ")}); it may or may not have been sent`;
    await checkpoint.save("blocked:gmail.send_followup", { code: "gmail:delivery_unconfirmed", message, attempts: st.sendAttempts, unconfirmed: true } satisfies Blocked);
    throw new ProviderError("gmail", 0, "delivery_unconfirmed", false, message);
  }
  // Anchor the next lookup to the send time, so wake-up latency never shifts the schedule.
  const dueIn = Math.max(0, sentAt + lookupOffsetMs(k + 1) - ctx.now());
  throw new RetryLater(dueIn, `confirmation lookup ${k}/${EMAIL_CONFIRMATION_LOOKUPS} at ${after}: ${st.lookupLog.at(-1)!.split(" ").slice(2).join(" ")}; next lookup at +${+(lookupOffsetMs(k + 1) / 60_000).toFixed(1)} min; not resending`, k === 1 ? "gmail:outcome_unknown" : "gmail:delivery_unknown");
}

// ---------------------------------------------------------------------------
// The team notification: completion, or the blocked step with instructions
// ---------------------------------------------------------------------------

const STEPS = [
  { id: "hubspot.contact", label: "HubSpot contact" },
  { id: "hubspot.deal", label: "HubSpot deal" },
  { id: "gmail.send_followup", label: "follow-up email (Gmail)" },
  { id: "calendar.followup_event", label: "follow-up call (Google Calendar)" },
] as const;

export async function teamMessage(ctx: Ctx): Promise<{ kind: "complete" | "blocked"; blockedStep?: string; text: string }> {
  const { input, applied, statuses, checkpoint, startedAt } = ctx;
  const lead = `${plain(input.name, 120)} ${esc(`<${input.email}>`)} (lead ${input.leadId})`;
  const marker = slackMarker(input.leadId);
  const slot = followUpSlot(startedAt);
  const email = applied["gmail.send_followup"];
  const blockedAt = STEPS.find((s) => statuses[s.id] !== "applied");

  if (!blockedAt) {
    return {
      kind: "complete",
      text: [
        `:white_check_mark: Lead followed up: ${lead}`,
        `• HubSpot contact ${applied["hubspot.contact"]!.ref}, deal ${applied["hubspot.deal"]!.ref}`,
        `• Follow-up email sent (Gmail ${email!.ref}, confirmed by ${String(email!.detail?.confirmedBy ?? "Gmail")})`,
        `• Follow-up call booked ${slot.start.slice(0, 16).replace("T", " ")} UTC (calendar event ${applied["calendar.followup_event"]!.ref})`,
        marker,
      ].join("\n"),
    };
  }

  const why = (await checkpoint.load<Blocked>(`blocked:${blockedAt.id}`)) ?? { code: statuses[blockedAt.id] ?? "unknown", message: `step ended ${statuses[blockedAt.id] ?? "without a result"}`, attempts: 0 };
  const done = STEPS.filter((s) => statuses[s.id] === "applied").map((s) => `${s.label} ${applied[s.id]!.ref}`);
  const notDone = STEPS.filter((s) => statuses[s.id] !== "applied").map((s) => s.label);
  const who = handoffOf(input);
  const msgId = followUpMessageId(input.leadId);
  const book = "book the follow-up call by hand";
  const call = `Follow-up call: suggested ${slot.start.slice(0, 16).replace("T", " ")} UTC; check ${input.calendarId} for event id ${followUpEventId(input.leadId)} first so there is only one.`;
  let todo: string;
  switch (blockedAt.id) {
    case "hubspot.contact":
    case "hubspot.deal":
      todo = `Nothing was emailed to the lead. Check the HubSpot token and its CRM scopes. Before creating anything by hand, search HubSpot for ${esc(input.email)} and for deals named "Lead ${input.leadId}" — create the contact/deal only if missing. Then send the follow-up email once and ${book}.`;
      break;
    case "gmail.send_followup":
      todo = why.unconfirmed
        ? `The email MAY have been sent: do not send it again blindly. In the sales mailbox search Sent for rfc822msgid:${esc(msgId)} (or check with the lead). If it is there, ${book}. If it is not, send the follow-up email once by hand, then ${book}. Resubmitting the form will not resend it.`
        : `Gmail refused the email, so nothing was sent to the lead. Check the mailbox credentials and sending limits, then send the follow-up email once by hand and ${book}.`;
      break;
    default:
      todo = `The follow-up email was sent and confirmed (Gmail ${email?.ref ?? "?"}). Only the calendar event is missing: ${book}.`;
  }
  return {
    kind: "blocked",
    blockedStep: blockedAt.id,
    text: [
      `:warning: ${who ? `<@${who}> ` : ""}Lead follow-up needs a person — blocked at *${blockedAt.label}*`,
      `Lead: ${lead}`,
      `Why: ${esc(why.message).slice(0, 400)} [${why.code}]`,
      `Done: ${done.length ? done.join(", ") : "nothing"}. Not done: ${notDone.join(", ")}.`,
      `What to do: ${todo}`,
      call,
      `Run: lead-${input.leadId} ${marker}`,
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// The workflow
// ---------------------------------------------------------------------------

export const leadFollowUp: WorkflowDef<Input> = {
  id: "lead-follow-up",
  title: "Inbound lead follow-up",
  org: "Sales",
  team: "sales-team",
  description:
    "On a lead form submission: find or create the HubSpot contact, create one sales deal, send one follow-up email through Gmail, book a Calendar follow-up only after the email is confirmed, and tell the team in Slack it is done or exactly which step is blocked. Every write reconciles before it repeats; an unconfirmed email gets an initial lookup and lookups 15 and 30 minutes after the send, then a person.",
  input: Input,
  runKey: (i) => `lead-${i.leadId}`,
  // Re-checks and confirmation lookups are durable timers: the deployed stack must wake them.
  tickEvery: "rate(1 minute)",
  // A worker that dies mid-run leaves the run RUNNING: the tick picks it up again (steps are reentrant).
  recoverStaleRuns: true,
  agents: [],

  plan({ input, startedAt }) {
    const slot = followUpSlot(startedAt);
    const actions: PlannedAction<Input>[] = [
      {
        id: "hubspot.contact",
        kind: "hubspot.find_or_create_contact",
        provider: "hubspot",
        agent: "lead-intake",
        gate: "auto",
        reentrant: true,
        summary: { email: input.email },
        execute: (ctx) =>
          attempt(ctx, "hubspot.contact", async () => {
            const hs = ctx.providers.hubspot!;
            const props = nameProps(input.name);
            const r = await reconcileThenWrite(
              ctx,
              "hubspot.contact",
              () => hs.findByEmail(input.email),
              async () => (await hs.createContactOnce(input.email, props)).contact,
              false, // CRM search lags behind writes: re-check later instead of an immediate search
            );
            // Never trust the write response alone: read the contact back.
            const saved = await hs.get(r.value.id);
            const ok = saved.properties.email?.toLowerCase() === input.email && (!r.created || r.via !== "write" || saved.properties.firstname === props.firstname);
            if (!ok) throw new ProviderError("hubspot", 200, "write_not_verified", false, `contact ${r.value.id} reads back as ${JSON.stringify({ email: saved.properties.email, firstname: saved.properties.firstname })}`);
            return { ref: r.value.id, detail: { created: r.created, via: r.via, verified: true } };
          }),
        async reconcile({ providers }, receipt) {
          const c = await providers.hubspot!.get(receipt.ref);
          return c.properties.email?.toLowerCase() === input.email ? { status: "match" } : { status: "drift", detail: `contact email is ${c.properties.email}` };
        },
      },
      {
        id: "hubspot.deal",
        kind: "hubspot.create_deal",
        provider: "hubspot",
        agent: "lead-intake",
        gate: "auto",
        reentrant: true,
        requires: ["hubspot.contact"],
        summary: { dealname: dealName(input), pipeline: process.env.LEAD_DEAL_PIPELINE ?? "default", dealstage: process.env.LEAD_DEAL_STAGE ?? "appointmentscheduled" },
        execute: (ctx) =>
          attempt(ctx, "hubspot.deal", async () => {
            const hs = ctx.providers.hubspot!;
            const contactId = ctx.applied["hubspot.contact"]!.ref;
            const want = { dealname: dealName(input), pipeline: process.env.LEAD_DEAL_PIPELINE ?? "default", dealstage: process.env.LEAD_DEAL_STAGE ?? "appointmentscheduled" };
            // The lead's deal: search by the lead token, then read that exact deal back by id.
            const ours = async () => {
              const deals = (await hs.searchDealsByNameToken(input.leadId)).filter((d) => isLeadDeal(d, input.leadId)).sort((a, b) => Number(a.id) - Number(b.id));
              return deals.length ? { deal: await hs.getDeal(deals[0]!.id), others: deals.length - 1 } : undefined;
            };
            const r = await reconcileThenWrite(ctx, "hubspot.deal", ours, async () => {
              const created = await hs.createDealOnce(want, contactId);
              return { deal: await hs.getDeal(created.id), others: 0 };
            }, false);
            const d = r.value.deal;
            const linked = (d.associations?.contacts?.results ?? []).some((a) => a.id === contactId);
            const drift = (Object.keys(want) as (keyof typeof want)[]).filter((k) => r.created && d.properties[k] !== want[k]);
            if (!isLeadDeal(d, input.leadId) || drift.length || (r.created && !linked)) {
              throw new ProviderError("hubspot", 200, "write_not_verified", false, `deal ${d.id} reads back with ${drift.length ? `different ${drift.join(", ")}` : ""}${r.created && !linked ? " no association to the contact" : ""}`.trim());
            }
            return { ref: d.id, detail: { created: r.created, via: r.via, contactId, associated: linked, verified: true, otherDealsForLead: r.value.others } };
          }),
        async reconcile({ providers }, receipt) {
          const d = await providers.hubspot!.getDeal(receipt.ref);
          if (!isLeadDeal(d, input.leadId)) return { status: "drift", detail: `deal name is ${d.properties.dealname}` };
          const n = (await providers.hubspot!.searchDealsByNameToken(input.leadId)).filter((x) => isLeadDeal(x, input.leadId)).length;
          return n === 1 ? { status: "match" } : { status: "drift", detail: `${n} deals for lead ${input.leadId}` };
        },
      },
      {
        id: "gmail.send_followup",
        kind: "gmail.send_followup",
        provider: "gmail",
        agent: "lead-intake",
        gate: "auto",
        reentrant: true,
        requires: ["hubspot.deal"],
        summary: { to: input.email, messageId: followUpMessageId(input.leadId), sends: true, confirmationLookups: EMAIL_CONFIRMATION_LOOKUPS },
        execute: sendFollowUp,
        async reconcile({ providers }, receipt) {
          const ids = await providers.gmail!.findByMessageId(followUpMessageId(input.leadId));
          if (!ids.length) return { status: "missing", detail: "no message with the follow-up Message-ID" };
          return ids.length === 1 && ids[0] === receipt.ref ? { status: "match" } : { status: "drift", detail: `${ids.length} message(s) with the follow-up Message-ID` };
        },
      },
      {
        id: "calendar.followup_event",
        kind: "calendar.create_followup_event",
        provider: "calendar",
        agent: "lead-intake",
        gate: "auto",
        reentrant: true,
        // Only after the email is confirmed: a failed or unconfirmed email skips it.
        requires: ["gmail.send_followup"],
        summary: { calendarId: input.calendarId, eventId: followUpEventId(input.leadId), start: slot.start, end: slot.end, invitesLead: false },
        execute: (ctx) =>
          attempt(ctx, "calendar.followup_event", async () => {
            if (ctx.applied["gmail.send_followup"]?.detail?.state !== "confirmed") throw new FatalError("the follow-up email is not confirmed");
            const cal = ctx.providers.calendar!;
            const id = followUpEventId(input.leadId);
            const existing = async () => {
              try {
                return await cal.getEvent(input.calendarId, id);
              } catch (err) {
                if (err instanceof ProviderError && err.status === 404) return undefined;
                throw err;
              }
            };
            const r = await reconcileThenWrite(ctx, "calendar.followup_event", existing, async () =>
              (
                await cal.insertEventWithId(input.calendarId, id, {
                  summary: `Follow-up call: ${plain(input.name, 100)} (lead ${input.leadId})`,
                  description: `Inbound lead ${input.leadId}: ${input.email}. HubSpot deal ${ctx.applied["hubspot.deal"]?.ref ?? "?"}. Follow-up email ${ctx.applied["gmail.send_followup"]!.ref} confirmed.`,
                  start: slot.start,
                  end: slot.end,
                })
              ).event,
            );
            return { ref: r.value.id, detail: { created: r.created, via: r.via, start: slot.start } };
          }),
        async reconcile({ providers }, receipt) {
          const ev = await providers.calendar!.getEvent(input.calendarId, receipt.ref);
          return ev.status === "cancelled" ? { status: "missing", detail: "event cancelled" } : { status: "match" };
        },
      },
      {
        id: "slack.notify_team",
        kind: "slack.notify_team",
        provider: "slack",
        agent: "lead-intake",
        gate: "auto",
        reentrant: true,
        // Waits for every step to settle (including the 30-minute email confirmation window).
        after: STEPS.map((s) => s.id),
        summary: { channel: channelOf(input), handoffUserId: handoffOf(input) ?? null, marker: slackMarker(input.leadId) },
        execute: (ctx) =>
          attempt(ctx, "slack.notify_team", async () => {
            const slack = ctx.providers.slack!;
            const channel = channelOf(input);
            const marker = slackMarker(input.leadId);
            const msg = await teamMessage(ctx);
            const r = await reconcileThenWrite(
              ctx,
              "slack.notify_team",
              async () => (await slack.history(channel, 100, reconcileReadTimeoutMs())).find((m) => m.text.includes(marker))?.ts,
              async () => (await slack.postMessageOnce(channel, msg.text)).ts,
            );
            return { ref: r.value, detail: { kind: msg.kind, blockedStep: msg.blockedStep ?? null, channel, created: r.created, via: r.via } };
          }),
        async reconcile({ providers }, receipt) {
          const ours = (await providers.slack!.history(channelOf(input), 100)).filter((m) => m.text.includes(slackMarker(input.leadId)));
          if (!ours.length) return { status: "missing", detail: "no message with the lead marker in the channel's latest 100" };
          return ours.length === 1 && ours[0]!.ts === receipt.ref ? { status: "match" } : { status: "drift", detail: `${ours.length} message(s) carry the lead marker` };
        },
      },
    ];
    return actions;
  },

  output({ input, startedAt }) {
    return {
      leadId: input.leadId,
      email: input.email,
      dealName: dealName(input),
      messageId: followUpMessageId(input.leadId),
      eventId: followUpEventId(input.leadId),
      followUpSlot: followUpSlot(startedAt),
      slackChannel: channelOf(input),
    };
  },

  catalog: [
    { kind: "hubspot.find_or_create_contact", provider: "hubspot", gate: "auto", description: "Find the contact by email or create it (409 adopts the existing one)" },
    { kind: "hubspot.create_deal", provider: "hubspot", gate: "auto", description: "Create the lead's one sales deal (named 'Lead <leadId> · <name>'), associated to the contact" },
    { kind: "gmail.send_followup", provider: "gmail", gate: "auto", description: "Send the follow-up email once (deterministic Message-ID); an unknown outcome gets an initial lookup, then lookups 15 and 30 minutes after the send, never a resend" },
    { kind: "calendar.create_followup_event", provider: "calendar", gate: "auto", description: "After the email is confirmed, create the follow-up call event (deterministic event id, no invitation sent)" },
    { kind: "slack.notify_team", provider: "slack", gate: "auto", description: "Tell the team the lead is done, or hand the blocked step to a person with instructions" },
  ],
};
