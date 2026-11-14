import { z } from "zod";
import { FatalError, ProviderError, SkipAction, errorMessage } from "../kit/errors";
import type { ActionContext, PlannedAction, WorkflowDef } from "../kit/types";
import type { GmailClient } from "../providers/google";
import { Email, money, out, plain, shortHash } from "./shared";

// Restaurant Operations · catering.
// Trigger: a catering request for a restaurant (e.g. a pizza shop) arrives by
// email, text, an ad lead form or the web form. The intake adapter turns it
// into one `start` per quote revision (runId = quoteId), and a customer's
// reply ("yes, book it" or "can you do $16 a head?") into a `signal` on the
// acceptance step or a new revision.
//
// Industry pattern followed (inquiry → quote → hold → accept → book → invoice →
// final-count → reminder):
//   - price per head from the headcount, by menu package, in code; a requested
//     price is honoured down to a floor, below that the floor is countered;
//   - the owner approves every quote (and every "no") before the customer
//     hears anything; nothing is sent without that approval;
//   - a quote is held for 7 days, but never closer than 48 h to the event;
//     only the latest sent revision can be accepted;
//   - acceptance books the owner's calendar (with day-before and 2-hour
//     reminders), sends a Stripe invoice due 72 h before the event, confirms
//     with follow-up instructions (final headcount by 72 h, the team calls
//     ~2 h before), and reminds the customer the day before.

export const POLICY = {
  version: "catering-2026-11",
  currency: "usd",
  packages: {
    classic: { label: "Classic pizza buffet", perHeadMinor: 1800 },
    premium: { label: "Premium pizza, salad and dessert", perHeadMinor: 2600 },
  },
  minHeadcount: 10,
  /** Larger parties need the owner on the phone (staffing, ovens). */
  maxAutoHeadcount: 150,
  /** Negotiation floor: at most this percent below list per head. */
  maxDiscountPct: 15,
  deliveryFeeMinor: 3500,
  minLeadHours: 48,
  maxLeadDays: 180,
  quoteValidDays: 7,
  /** A quote can't be accepted closer to the event than this (prep and ordering). */
  acceptBeforeEventHours: 48,
  maxRevisions: 3,
  invoiceDueBeforeEventHours: 72,
  finalHeadcountBeforeEventHours: 72,
  customerReminderBeforeEventHours: 24,
  dayOfCallBeforeEventMinutes: 120,
  /** Kitchen prep before and pack-up after the event block the calendar. */
  setupBufferMinutes: 90,
  teardownMinutes: 30,
  /** Popup reminders on the owner's calendar event. */
  ownerReminderMinutes: [24 * 60, 120],
} as const;

/** The intake adapter's identity when it relays a customer's email/SMS reply. */
export const CUSTOMER_REPLY_ACTOR = "inbox:customer-reply";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const timeZone = z
  .string()
  .min(1)
  .max(60)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "IANA time zone like America/New_York");

const Input = z
  .object({
    /** Stable id of the conversation with this customer, e.g. CAT-2026-0142. */
    inquiryId: z.string().regex(/^CAT-[A-Za-z0-9_-]{3,60}$/, "inquiry id like CAT-2026-0142"),
    /** 1 for the first quote; each counter-offer from the customer is a new revision. */
    revision: z.number().int().min(1).max(20).default(1),
    source: z.enum(["email", "sms", "ad_form", "web_form", "phone"]),
    customer: z.object({
      name: z.string().trim().min(1).max(120),
      email: Email,
      phone: z.string().regex(/^\+?[0-9 ()-]{7,20}$/).optional(),
    }),
    event: z.object({
      start: z.iso.datetime({ offset: true }),
      durationMinutes: z.number().int().min(30).max(480).default(120),
      headcount: z.number().int().min(1).max(2000),
      fulfillment: z.enum(["pickup", "delivery"]),
      address: z.string().trim().min(5).max(300).optional(),
      notes: z.string().max(1000).optional(),
    }),
    package: z.enum(["classic", "premium"]),
    /** The customer's asked-for price per head in cents, if they negotiated. */
    requestedPerHeadMinor: z.number().int().min(0).max(100_000).optional(),
    owner: z.object({
      name: z.string().trim().min(1).max(120),
      email: Email,
      phone: z.string().regex(/^\+?[0-9 ()-]{7,20}$/),
      calendarId: z.string().min(1).max(200).default("primary"),
      timeZone: timeZone.default("America/New_York"),
    }),
    /** Who may approve quotes (the owner and, optionally, a manager). */
    approvers: z.array(z.string().min(1)).min(1).max(10),
  })
  .refine((i) => i.event.fulfillment !== "delivery" || !!i.event.address, { message: "delivery needs an address", path: ["event", "address"] });
export type Input = z.infer<typeof Input>;

export type DecisionKind = "quote" | "decline" | "manual";
export type Negotiation = "list" | "accepted_counter" | "countered";

export interface Facts {
  /** null when the calendar couldn't be read. */
  calendarConflict: boolean | null;
  /** null when billing couldn't be read; otherwise the saved state of this inquiry ("<quoteId>|sent|accepted") or "". */
  inquiryState: string | null;
}

export interface Decision {
  kind: DecisionKind;
  reasons: string[];
  quoteId: string;
  listPerHeadMinor: number;
  floorPerHeadMinor: number;
  perHeadMinor: number;
  negotiation: Negotiation;
  foodMinor: number;
  deliveryMinor: number;
  totalMinor: number;
  validUntil: string;
}

export const quoteIdOf = (i: Pick<Input, "inquiryId" | "revision">) => `${i.inquiryId}-r${i.revision}`;
/** Stripe metadata key holding the inquiry's state on the customer (keys are capped at 40 chars). */
export const stateKey = (inquiryId: string) => `catering_${shortHash(inquiryId)}`;

export function eventWindow(input: Input) {
  const start = Date.parse(input.event.start);
  return { start, end: start + input.event.durationMinutes * 60_000 };
}

/** Price per head after negotiation. Pure. */
export function negotiate(listPerHeadMinor: number, requested?: number): { perHeadMinor: number; negotiation: Negotiation; floorPerHeadMinor: number } {
  const floorPerHeadMinor = Math.ceil((listPerHeadMinor * (100 - POLICY.maxDiscountPct)) / 100);
  if (requested === undefined || requested >= listPerHeadMinor) return { perHeadMinor: listPerHeadMinor, negotiation: "list", floorPerHeadMinor };
  if (requested >= floorPerHeadMinor) return { perHeadMinor: requested, negotiation: "accepted_counter", floorPerHeadMinor };
  return { perHeadMinor: floorPerHeadMinor, negotiation: "countered", floorPerHeadMinor };
}

/** Every business rule of the quote desk. Pure: same input, clock and facts → same decision. */
export function decide(input: Input, now: Date, facts: Facts): Decision {
  const quoteId = quoteIdOf(input);
  const listPerHeadMinor = POLICY.packages[input.package].perHeadMinor;
  const n = negotiate(listPerHeadMinor, input.requestedPerHeadMinor);
  const foodMinor = n.perHeadMinor * input.event.headcount;
  const deliveryMinor = input.event.fulfillment === "delivery" ? POLICY.deliveryFeeMinor : 0;
  const { start } = eventWindow(input);
  const validUntil = new Date(Math.min(now.getTime() + POLICY.quoteValidDays * DAY, start - POLICY.acceptBeforeEventHours * HOUR)).toISOString();

  const declines: string[] = [];
  const manual: string[] = [];
  // A booked customer is never declined automatically: changes to a confirmed booking are the owner's call,
  // and the booking itself now fills the slot (it isn't a conflict with someone else).
  const st = facts.inquiryState ?? "";
  const alreadyBooked = st.endsWith("|accepted") && !st.startsWith(`${quoteId}|`);
  if (alreadyBooked) manual.push("already_booked");
  if (!alreadyBooked) {
    if (input.event.headcount < POLICY.minHeadcount) declines.push("headcount_below_minimum");
    if (start - now.getTime() < POLICY.minLeadHours * HOUR) declines.push("short_notice");
    if (start - now.getTime() > POLICY.maxLeadDays * DAY) declines.push("too_far_ahead");
    if (facts.calendarConflict === true) declines.push("date_unavailable");
  }
  if (input.revision > POLICY.maxRevisions) manual.push("negotiation_rounds_exceeded");
  if (input.event.headcount > POLICY.maxAutoHeadcount) manual.push("large_party");
  if (facts.calendarConflict === null) manual.push("availability_unknown");
  if (facts.inquiryState === null) manual.push("billing_unavailable");

  const kind: DecisionKind = declines.length ? "decline" : manual.length ? "manual" : "quote";
  return {
    kind,
    reasons: declines.length ? declines : manual,
    quoteId,
    listPerHeadMinor,
    floorPerHeadMinor: n.floorPerHeadMinor,
    perHeadMinor: n.perHeadMinor,
    negotiation: n.negotiation,
    foodMinor,
    deliveryMinor,
    totalMinor: foodMinor + deliveryMinor,
    validUntil,
  };
}

/** Invoice due date: 72 h before the event, but never sooner than a day after it is issued. */
export function invoiceDueSec(eventStartMs: number, nowMs: number): number {
  return Math.floor(Math.max(eventStartMs - POLICY.invoiceDueBeforeEventHours * HOUR, nowMs + DAY) / 1000);
}

const REASON_TEXT: Record<string, string> = {
  headcount_below_minimum: `we cater parties of ${POLICY.minHeadcount} or more`,
  short_notice: `we need at least ${POLICY.minLeadHours} hours' notice for catering`,
  too_far_ahead: `we book catering up to ${POLICY.maxLeadDays} days ahead`,
  date_unavailable: "our kitchen is already booked for that time",
  already_booked: "this inquiry already has an accepted booking",
  negotiation_rounds_exceeded: `more than ${POLICY.maxRevisions} quote revisions`,
  large_party: `more than ${POLICY.maxAutoHeadcount} guests`,
  availability_unknown: "the catering calendar couldn't be checked",
  billing_unavailable: "billing (Stripe) couldn't be checked",
};

function when(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(ms));
}

function firstName(name: string) {
  return plain(name.split(/\s+/)[0] ?? name, 60);
}

/** Deterministic RFC 5322 Message-ID: a retry is recognisable in Gmail by rfc822msgid. */
export function mailId(quoteId: string, purpose: string, ownerEmail: string) {
  return `<${purpose}.${shortHash(quoteId, purpose)}@${ownerEmail.split("@")[1]}>`;
}

/**
 * Send once; never blindly resend. A definite refusal (4xx) fails the step.
 * An ambiguous outcome (timeout, lost response, 5xx) is resolved by looking the
 * Message-ID up in the mailbox: found → the earlier send is recorded; not found
 * → the step fails and a later retry looks up first; lookup unavailable → the
 * step fails as `gmail:send_uncertain` and is not resent automatically.
 */
export async function sendOnce(gmail: GmailClient, mail: { to: string; subject: string; body: string; messageId: string }, retrying: boolean): Promise<{ id: string; recovered: boolean }> {
  if (retrying) {
    const prior = await gmail.findSentByMessageId(mail.messageId);
    if (prior) return { id: prior.id, recovered: true };
  }
  try {
    return { ...(await gmail.sendMessage(mail)), recovered: false };
  } catch (err) {
    if (!(err instanceof ProviderError) || !(err.status === 0 || err.status >= 500)) throw err;
    let prior: { id: string } | undefined;
    try {
      prior = await gmail.findSentByMessageId(mail.messageId);
    } catch (lookupErr) {
      throw new ProviderError("gmail", 0, "send_uncertain", false, `send outcome unknown (${errorMessage(err)}); lookup failed (${errorMessage(lookupErr)}); not resent`);
    }
    if (prior) return { id: prior.id, recovered: true };
    throw err;
  }
}

interface Crm {
  contactId: string | null;
  lifecycle: string | null;
}
interface Availability {
  conflict: boolean;
  busy: { start: string; end: string }[];
}
interface Billing {
  customerId: string | null;
  inquiryState: string;
}
interface Desk {
  decision: Decision;
  quoteMail: { subject: string; body: string; draftedBy: string };
  declineMail: { subject: string; body: string; draftedBy: string };
}

const PRE_CUSTOMER = new Set(["", "subscriber", "lead", "marketingqualifiedlead", "salesqualifiedlead", "opportunity"]);

const A = {
  crm: "hubspot.upsert_contact",
  quote: "gmail.send_quote",
  record: "stripe.record_quote",
  accept: "quote.customer_acceptance",
  book: "calendar.book_event",
  invoice: "stripe.send_invoice",
  confirm: "gmail.send_confirmation",
  customer: "hubspot.mark_customer",
  reminder: "gmail.send_reminder",
  decline: "gmail.send_decline",
  owner: "gmail.notify_owner",
} as const;

export const cateringQuote: WorkflowDef<Input> = {
  id: "catering-quote",
  title: "Catering quote to booking",
  org: "Restaurant Operations",
  team: "catering",
  description:
    "A catering request (email, text or ad lead) is priced per head in code, negotiated down to a floor, and quoted only after the owner approves. The latest quote, once the customer accepts, books the owner's calendar, sends a Stripe invoice due 72 h before the event, confirms with follow-up instructions, and reminds the customer a day before.",
  input: Input,
  audit: true,
  tickEvery: "rate(15 minutes)",
  agents: [
    {
      name: "crm-lookup",
      needs: ["hubspot"],
      async run({ input, providers }) {
        const c = await providers.hubspot!.findByEmail(input.customer.email);
        const data: Crm = { contactId: c?.id ?? null, lifecycle: c?.properties.lifecyclestage ?? null };
        return { summary: c ? `contact ${c.id} (${data.lifecycle ?? "no stage"})` : "new contact", data };
      },
    },
    {
      name: "availability",
      needs: ["calendar"],
      async run({ input, providers }) {
        const { start, end } = eventWindow(input);
        const from = new Date(start - POLICY.setupBufferMinutes * 60_000).toISOString();
        const to = new Date(end + POLICY.teardownMinutes * 60_000).toISOString();
        const busy = await providers.calendar!.busy(input.owner.calendarId, from, to);
        const overlapping = busy.filter((b) => Date.parse(b.start) < Date.parse(to) && Date.parse(b.end) > Date.parse(from));
        const data: Availability = { conflict: overlapping.length > 0, busy: overlapping };
        return { summary: data.conflict ? `kitchen busy (${overlapping.length} booking(s))` : "kitchen free", data };
      },
    },
    {
      name: "billing-lookup",
      needs: ["stripe"],
      async run({ input, providers }) {
        const c = await providers.stripe!.findCustomerByEmail(input.customer.email);
        const data: Billing = { customerId: c?.id ?? null, inquiryState: c?.metadata?.[stateKey(input.inquiryId)] ?? "" };
        return { summary: c ? `Stripe customer ${c.id}${data.inquiryState ? ` (${data.inquiryState})` : ""}` : "new Stripe customer", data };
      },
    },
  ],

  compose: {
    name: "quote-desk",
    async run({ input, drafter, startedAt }, results) {
      const avail = out<Availability>(results, "availability");
      const billing = out<Billing>(results, "billing-lookup");
      const d = decide(input, startedAt, { calendarConflict: avail ? avail.conflict : null, inquiryState: billing ? billing.inquiryState : null });
      const tz = input.owner.timeZone;
      const { start } = eventWindow(input);
      const pkg = POLICY.packages[input.package];
      const lines = [
        `${input.event.headcount} guests × ${pkg.label} at ${money(d.perHeadMinor)} per person: ${money(d.foodMinor)}`,
        ...(d.deliveryMinor ? [`Delivery to ${plain(input.event.address ?? "", 200)}: ${money(d.deliveryMinor)}`] : [`Pickup at the restaurant`]),
        `Total: ${money(d.totalMinor)}`,
      ].join("\n");
      const priceNote =
        d.negotiation === "accepted_counter"
          ? `We're happy to do ${money(d.perHeadMinor)} per person as you asked.`
          : d.negotiation === "countered"
            ? `We can't go as low as ${money(input.requestedPerHeadMinor ?? 0)} per person; the best we can do is ${money(d.perHeadMinor)}.`
            : "";
      const quoteMail = await drafter.draft({
        task: "catering-quote",
        instructions:
          "Draft a short, friendly catering quote email from a restaurant owner. Use exactly the lines, prices, validity date and quote reference given; do not invent menu items, discounts or terms. Tell the customer to reply 'yes' to book, or reply with any changes.",
        facts: { firstName: firstName(input.customer.name), when: when(start, tz), lines, priceNote, validUntil: when(Date.parse(d.validUntil), tz), quoteId: d.quoteId, owner: input.owner.name },
        fallback: {
          subject: `Your catering quote ${d.quoteId}: ${money(d.totalMinor)} for ${input.event.headcount} guests`,
          body: `Hi ${firstName(input.customer.name)},\n\nThanks for thinking of us for your event on ${when(start, tz)}. Here is your quote (${d.quoteId}):\n\n${lines}\n${priceNote ? `\n${priceNote}\n` : ""}\nWe'll hold the date for you until ${when(Date.parse(d.validUntil), tz)}. Reply "yes" to book, or reply with any changes (guests, menu, price) and we'll send a revised quote.\n\nOnce you confirm, you'll get a calendar confirmation and an invoice payable online.\n\n${input.owner.name}`,
        },
      });
      const why = d.reasons.map((r) => REASON_TEXT[r] ?? r).join("; ");
      const declineMail = await drafter.draft({
        task: "catering-decline",
        instructions: "Draft a short, kind email from a restaurant owner saying they can't take this catering request, with the reason given. Offer to help with another date or a regular takeout order. Do not invent alternatives that weren't given.",
        facts: { firstName: firstName(input.customer.name), when: when(start, tz), reason: why, owner: input.owner.name, phone: input.owner.phone },
        fallback: {
          subject: `About your catering request for ${when(start, tz)}`,
          body: `Hi ${firstName(input.customer.name)},\n\nThank you for your catering request. Unfortunately we can't take it: ${why}.\n\nIf another date works, or a regular takeout order would help, just reply or call us at ${input.owner.phone}.\n\n${input.owner.name}`,
        },
      });
      const data: Desk = { decision: d, quoteMail, declineMail };
      return { summary: `${d.kind}${d.reasons.length ? ` (${d.reasons.join(", ")})` : ""}: ${money(d.totalMinor)} (${d.negotiation})`, data };
    },
  },

  plan({ input }, results) {
    const desk = out<Desk>(results, "quote-desk");
    if (!desk) return [];
    const d = desk.decision;
    const crm = out<Crm>(results, "crm-lookup");
    const billing = out<Billing>(results, "billing-lookup");
    const tz = input.owner.timeZone;
    const { start, end } = eventWindow(input);
    const key = stateKey(input.inquiryId);
    const id = (purpose: string) => mailId(d.quoteId, purpose, input.owner.email);
    const actions: PlannedAction<Input>[] = [];
    const retrying = (ctx: ActionContext<Input>, actionId: string) => ctx.statuses[actionId] === "failed";

    if (crm) {
      actions.push({
        id: A.crm,
        kind: A.crm,
        provider: "hubspot",
        agent: "crm-lookup",
        gate: "auto",
        summary: { email: input.customer.email, stage: PRE_CUSTOMER.has(crm.lifecycle ?? "") && d.kind === "quote" ? "opportunity" : "unchanged" },
        async execute({ providers }) {
          const [first, ...rest] = input.customer.name.split(/\s+/);
          const props: Record<string, string> = { firstname: first ?? input.customer.name };
          if (rest.length) props.lastname = rest.join(" ");
          if (input.customer.phone) props.phone = input.customer.phone;
          // Never move a customer backwards in the lifecycle.
          if (d.kind === "quote" && PRE_CUSTOMER.has(crm.lifecycle ?? "") && crm.lifecycle !== "opportunity") props.lifecyclestage = "opportunity";
          const { contact, created } = await providers.hubspot!.upsertByEmail(input.customer.email, props);
          return { ref: contact.id, detail: { created } };
        },
      });
    }

    if (d.kind === "quote") {
      actions.push({
        id: A.quote,
        kind: A.quote,
        provider: "gmail",
        agent: "quote-desk",
        // The owner finalizes every quote: nothing reaches the customer before approval.
        gate: "approval",
        summary: { to: input.customer.email, quoteId: d.quoteId, headcount: input.event.headcount, perHead: money(d.perHeadMinor), list: money(d.listPerHeadMinor), negotiation: d.negotiation, total: money(d.totalMinor), validUntil: d.validUntil, subject: desk.quoteMail.subject, preview: desk.quoteMail.body.slice(0, 600), draftedBy: desk.quoteMail.draftedBy },
        async execute(ctx) {
          const stripe = ctx.providers.stripe!;
          // Re-check at send time: another revision may have been accepted while this one waited.
          const cust = billing?.customerId ? await stripe.getCustomer(billing.customerId) : await stripe.findCustomerByEmail(input.customer.email);
          const st = cust?.metadata?.[key] ?? "";
          if (st.endsWith("|accepted") && !st.startsWith(`${d.quoteId}|`)) throw new SkipAction(`inquiry already booked (${st.split("|")[0]})`);
          const sent = await sendOnce(ctx.providers.gmail!, { to: input.customer.email, subject: desk.quoteMail.subject, body: desk.quoteMail.body, messageId: id("quote") }, retrying(ctx, A.quote));
          return { ref: sent.id, detail: { messageId: id("quote"), recovered: sent.recovered, sentAt: new Date().toISOString() } };
        },
      });
      actions.push({
        id: A.record,
        kind: A.record,
        provider: "stripe",
        agent: "billing-lookup",
        gate: "auto",
        summary: { email: input.customer.email, quoteId: d.quoteId, existingCustomer: billing?.customerId ?? null },
        dependsOn: [A.quote],
        async execute({ providers }) {
          const stripe = providers.stripe!;
          let customerId = billing?.customerId ?? (await stripe.findCustomerByEmail(input.customer.email))?.id;
          let created = false;
          if (!customerId) {
            customerId = (await stripe.createCustomer(input.customer.email, input.customer.name, { source: "catering" }, `catering-${input.inquiryId}-customer`)).id;
            created = true;
          }
          // The newest sent revision is the only one that can be accepted.
          await stripe.updateCustomerMetadata(customerId, { [key]: `${d.quoteId}|sent` });
          return { ref: customerId, detail: { created, state: `${d.quoteId}|sent` } };
        },
      });
      actions.push({
        id: A.accept,
        kind: A.accept,
        provider: "stripe",
        agent: "quote-desk",
        gate: "auto",
        summary: { quoteId: d.quoteId, acceptBy: d.validUntil, acceptedVia: [CUSTOMER_REPLY_ACTOR, ...input.approvers] },
        dependsOn: [A.quote, A.record],
        awaitSignal: { from: [CUSTOMER_REPLY_ACTOR, ...input.approvers], deadline: d.validUntil, onDeadline: "reject" },
        async execute({ providers, applied, signal }) {
          const sentAt = applied[A.quote]?.detail?.sentAt as string | undefined;
          if (signal && !signal.defaulted && sentAt && Date.parse(signal.at) < Date.parse(sentAt)) throw new SkipAction("acceptance arrived before the quote was sent");
          const stripe = providers.stripe!;
          const customerId = applied[A.record]!.ref;
          const st = (await stripe.getCustomer(customerId)).metadata?.[key] ?? "";
          if (st !== `${d.quoteId}|sent`) throw new SkipAction(st.endsWith("|accepted") ? `inquiry already booked (${st.split("|")[0]})` : `superseded by ${st.split("|")[0] || "another quote"}`);
          await stripe.updateCustomerMetadata(customerId, { [key]: `${d.quoteId}|accepted` });
          return { ref: d.quoteId, detail: { acceptedBy: signal?.by ?? null, acceptedAt: signal?.at ?? null } };
        },
      });
      actions.push({
        id: A.book,
        kind: A.book,
        provider: "calendar",
        agent: "availability",
        gate: "auto",
        summary: { calendar: input.owner.calendarId, start: input.event.start, headcount: input.event.headcount, fulfillment: input.event.fulfillment, reminders: POLICY.ownerReminderMinutes },
        dependsOn: [A.accept],
        async execute({ providers }) {
          const prep = start - POLICY.setupBufferMinutes * 60_000;
          const ev = await providers.calendar!.insertEvent(
            input.owner.calendarId,
            {
              summary: `Catering: ${plain(input.customer.name, 60)}, ${input.event.headcount} guests (${input.event.fulfillment})`,
              description: [
                `Quote ${d.quoteId} · ${POLICY.packages[input.package].label} · ${money(d.perHeadMinor)}/person · total ${money(d.totalMinor)}`,
                `Kitchen prep from ${when(prep, tz)}`,
                input.event.fulfillment === "delivery" ? `Deliver to: ${plain(input.event.address ?? "", 200)}` : "Customer picks up",
                `Customer: ${plain(input.customer.name, 80)} · ${input.customer.email}${input.customer.phone ? ` · ${input.customer.phone}` : ""}`,
                `Call the customer ~${POLICY.dayOfCallBeforeEventMinutes / 60} h before.`,
                ...(input.event.notes ? [`Notes (from customer): ${plain(input.event.notes, 500)}`] : []),
              ].join("\n"),
              start: new Date(start).toISOString(),
              end: new Date(end).toISOString(),
              privateKey: d.quoteId,
              privateProps: { cateringQuote: d.quoteId },
              reminderMinutes: [...POLICY.ownerReminderMinutes],
            },
            "none",
          );
          return { ref: ev.id, detail: { start: ev.start?.dateTime ?? null } };
        },
        async reconcile({ providers }, receipt) {
          const ev = await providers.calendar!.getEvent(input.owner.calendarId, receipt.ref);
          if (ev.status === "cancelled") return { status: "missing", detail: "event cancelled" };
          return ev.start?.dateTime && Date.parse(ev.start.dateTime) !== start ? { status: "drift", detail: `moved to ${ev.start.dateTime}` } : { status: "match" };
        },
      });
      actions.push({
        id: A.invoice,
        kind: A.invoice,
        provider: "stripe",
        agent: "billing-lookup",
        gate: "auto",
        summary: { to: input.customer.email, total: money(d.totalMinor), dueBeforeEventHours: POLICY.invoiceDueBeforeEventHours },
        dependsOn: [A.accept],
        async execute({ providers, applied }) {
          const stripe = providers.stripe!;
          const customer = applied[A.record]!.ref;
          // Twins (and timeouts) can't promise Idempotency-Key replay: find this quote's invoice before creating one.
          let inv = (await stripe.listCustomerInvoices(customer)).find((x) => x.metadata?.catering_quote === d.quoteId && x.status !== "void");
          if (!inv) {
            inv = await stripe.createSendInvoiceDraft(customer, `Catering ${d.quoteId}: ${input.event.headcount} guests on ${when(start, tz)}`, invoiceDueSec(start, Date.now()), { catering_quote: d.quoteId, catering_inquiry: input.inquiryId }, `catering-${d.quoteId}-invoice`);
          }
          if (inv.status === "draft") {
            if (inv.amount_due === 0) {
              await stripe.addInvoiceAmountLine(inv.id, customer, d.foodMinor, POLICY.currency, `${input.event.headcount} × ${POLICY.packages[input.package].label} at ${money(d.perHeadMinor)}`, `catering-${d.quoteId}-food`);
              if (d.deliveryMinor) await stripe.addInvoiceAmountLine(inv.id, customer, d.deliveryMinor, POLICY.currency, "Delivery", `catering-${d.quoteId}-delivery`);
              inv = await stripe.getInvoice(inv.id);
            }
            if (inv.amount_due !== d.totalMinor) throw new FatalError(`draft invoice ${inv.id} is ${inv.amount_due}, expected ${d.totalMinor}: fix by hand`);
            inv = await stripe.finalizeInvoiceDefault(inv.id);
          }
          if (inv.status === "open") inv = await stripe.sendInvoice(inv.id);
          const due = typeof inv.due_date === "number" ? inv.due_date : null;
          return { ref: inv.id, detail: { status: inv.status, amountDue: inv.amount_due, dueDate: due, hostedUrl: inv.hosted_invoice_url ?? null } };
        },
        async reconcile({ providers }, receipt) {
          const inv = await providers.stripe!.getInvoice(receipt.ref);
          if (inv.status === "void" || inv.status === "uncollectible") return { status: "missing", detail: `invoice ${inv.status}` };
          if (inv.status === "paid") return { status: "match", detail: "paid" };
          return inv.amount_due === d.totalMinor ? { status: "match" } : { status: "drift", detail: `amount due ${inv.amount_due}, quoted ${d.totalMinor}` };
        },
      });
      actions.push({
        id: A.confirm,
        kind: A.confirm,
        provider: "gmail",
        agent: "quote-desk",
        gate: "auto",
        summary: { to: input.customer.email, quoteId: d.quoteId },
        dependsOn: [A.book, A.invoice],
        async execute(ctx) {
          const inv = ctx.applied[A.invoice]!.detail ?? {};
          const finalCountBy = when(start - POLICY.finalHeadcountBeforeEventHours * HOUR, tz);
          const dueText = typeof inv.dueDate === "number" ? when(inv.dueDate * 1000, tz) : `${POLICY.invoiceDueBeforeEventHours} hours before the event`;
          const body = [
            `Hi ${firstName(input.customer.name)},`,
            "",
            `You're booked! ${input.event.headcount} guests, ${POLICY.packages[input.package].label}, on ${when(start, tz)} (${input.event.fulfillment === "delivery" ? `delivery to ${plain(input.event.address ?? "", 200)}` : "pickup at the restaurant"}).`,
            "",
            `Invoice: ${money(d.totalMinor)}, due ${dueText}. Stripe has emailed it to you${inv.hostedUrl ? `; you can also pay here: ${inv.hostedUrl}` : ""}.`,
            "",
            "What happens next:",
            `- Final headcount: reply to this email or call ${input.owner.phone} by ${finalCountBy}. After that we can't change quantities.`,
            `- The day before, we'll send you a reminder.`,
            `- On the day, our catering team will call you about ${POLICY.dayOfCallBeforeEventMinutes / 60} hours before ${input.event.fulfillment === "delivery" ? "delivery" : "pickup"}${input.customer.phone ? ` at ${input.customer.phone}` : ""}.`,
            `- Questions any time: reply here or call ${input.owner.phone}.`,
            "",
            `Thank you! ${input.owner.name}`,
          ].join("\n");
          const sent = await sendOnce(ctx.providers.gmail!, { to: input.customer.email, subject: `Confirmed: your catering on ${when(start, tz)} (${d.quoteId})`, body, messageId: id("confirmation") }, retrying(ctx, A.confirm));
          return { ref: sent.id, detail: { messageId: id("confirmation"), recovered: sent.recovered } };
        },
      });
      if (crm) {
        actions.push({
          id: A.customer,
          kind: A.customer,
          provider: "hubspot",
          agent: "crm-lookup",
          gate: "auto",
          summary: { email: input.customer.email, stage: "customer" },
          dependsOn: [A.accept],
          async execute({ providers }) {
            const { contact } = await providers.hubspot!.upsertByEmail(input.customer.email, { lifecyclestage: "customer" });
            return { ref: contact.id };
          },
        });
      }
      actions.push({
        id: A.reminder,
        kind: A.reminder,
        provider: "gmail",
        agent: "quote-desk",
        gate: "auto",
        summary: { to: input.customer.email, at: new Date(start - POLICY.customerReminderBeforeEventHours * HOUR).toISOString() },
        dependsOn: [A.confirm],
        waitUntil: new Date(start - POLICY.customerReminderBeforeEventHours * HOUR).toISOString(),
        async execute(ctx) {
          const ev = await ctx.providers.calendar!.getEvent(input.owner.calendarId, ctx.applied[A.book]!.ref);
          if (ev.status === "cancelled") throw new SkipAction("event cancelled");
          const inv = await ctx.providers.stripe!.getInvoice(ctx.applied[A.invoice]!.ref);
          if (inv.status === "void" || inv.status === "uncollectible") throw new SkipAction(`invoice ${inv.status}`);
          const pay = inv.status === "paid" ? "Your invoice is paid, thank you." : `Your invoice (${money(inv.amount_remaining ?? inv.amount_due)}) is still open${inv.hosted_invoice_url ? `: ${inv.hosted_invoice_url}` : ""}.`;
          const body = `Hi ${firstName(input.customer.name)},\n\nA reminder that your catering for ${input.event.headcount} guests is tomorrow, ${when(start, tz)} (${input.event.fulfillment === "delivery" ? `delivery to ${plain(input.event.address ?? "", 200)}` : "pickup at the restaurant"}).\n\n${pay}\n\nOur team will call you about ${POLICY.dayOfCallBeforeEventMinutes / 60} hours before. Anything urgent: ${input.owner.phone}.\n\n${input.owner.name}`;
          const sent = await sendOnce(ctx.providers.gmail!, { to: input.customer.email, subject: `Tomorrow: your catering (${d.quoteId})`, body, messageId: id("reminder") }, retrying(ctx, A.reminder));
          return { ref: sent.id, detail: { messageId: id("reminder"), invoiceStatus: inv.status, recovered: sent.recovered } };
        },
      });
    }

    if (d.kind === "decline") {
      actions.push({
        id: A.decline,
        kind: A.decline,
        provider: "gmail",
        agent: "quote-desk",
        // A "no" is the owner's call too.
        gate: "approval",
        summary: { to: input.customer.email, reasons: d.reasons, subject: desk.declineMail.subject, preview: desk.declineMail.body.slice(0, 600), draftedBy: desk.declineMail.draftedBy },
        async execute(ctx) {
          const sent = await sendOnce(ctx.providers.gmail!, { to: input.customer.email, subject: desk.declineMail.subject, body: desk.declineMail.body, messageId: id("decline") }, retrying(ctx, A.decline));
          return { ref: sent.id, detail: { messageId: id("decline"), recovered: sent.recovered } };
        },
      });
    }

    if (d.kind === "manual") {
      actions.push({
        id: A.owner,
        kind: A.owner,
        provider: "gmail",
        agent: "quote-desk",
        gate: "auto",
        summary: { to: input.owner.email, reasons: d.reasons },
        async execute(ctx) {
          const body = `Catering request ${input.inquiryId} (revision ${input.revision}) needs you: ${d.reasons.map((r) => REASON_TEXT[r] ?? r).join("; ")}.\n\n${plain(input.customer.name, 80)} · ${input.customer.email}${input.customer.phone ? ` · ${input.customer.phone}` : ""}\n${input.event.headcount} guests, ${POLICY.packages[input.package].label}, ${when(start, tz)}, ${input.event.fulfillment}.\nList price would be ${money(d.totalMinor)}. Nothing was sent to the customer.`;
          const sent = await sendOnce(ctx.providers.gmail!, { to: input.owner.email, subject: `Catering request needs you: ${plain(input.customer.name, 60)}, ${input.event.headcount} guests`, body, messageId: id("owner") }, retrying(ctx, A.owner));
          return { ref: sent.id, detail: { messageId: id("owner") } };
        },
      });
    }
    return actions;
  },

  output({ input }, results) {
    const desk = out<Desk>(results, "quote-desk");
    if (!desk) return { inquiryId: input.inquiryId, decision: "not decided" };
    const d = desk.decision;
    return {
      inquiryId: input.inquiryId,
      quoteId: d.quoteId,
      decision: d.kind,
      reasons: d.reasons,
      headcount: input.event.headcount,
      package: input.package,
      listPerHeadMinor: d.listPerHeadMinor,
      floorPerHeadMinor: d.floorPerHeadMinor,
      perHeadMinor: d.perHeadMinor,
      negotiation: d.negotiation,
      foodMinor: d.foodMinor,
      deliveryMinor: d.deliveryMinor,
      totalMinor: d.totalMinor,
      currency: POLICY.currency,
      validUntil: d.validUntil,
      policyVersion: POLICY.version,
    };
  },

  catalog: [
    { kind: A.crm, provider: "hubspot", gate: "auto", description: "Create/update the customer contact (opportunity when quoted; never downgraded)" },
    { kind: A.quote, provider: "gmail", gate: "approval", description: "Send the per-head quote once the owner approves it" },
    { kind: A.record, provider: "stripe", gate: "auto", description: "Find or create the Stripe customer and mark this revision as the one that can be accepted" },
    { kind: A.accept, provider: "stripe", gate: "auto", description: "Signal: the customer (via the inbox adapter) or the owner accepts the latest quote before it expires" },
    { kind: A.book, provider: "calendar", gate: "auto", description: "Book the event on the owner's catering calendar with day-before and 2-hour reminders" },
    { kind: A.invoice, provider: "stripe", gate: "auto", description: "Create, finalize and send the Stripe invoice, due 72 h before the event" },
    { kind: A.confirm, provider: "gmail", gate: "auto", description: "Confirm the booking with invoice and follow-up instructions (final count, day-of call)" },
    { kind: A.customer, provider: "hubspot", gate: "auto", description: "Mark the contact a customer" },
    { kind: A.reminder, provider: "gmail", gate: "auto", description: "Remind the customer the day before (skipped if the event or invoice was cancelled)" },
    { kind: A.decline, provider: "gmail", gate: "approval", description: "Send a polite decline once the owner approves it" },
    { kind: A.owner, provider: "gmail", gate: "auto", description: "Tell the owner a request needs them (large party, too many rounds, systems unavailable)" },
  ],
};
