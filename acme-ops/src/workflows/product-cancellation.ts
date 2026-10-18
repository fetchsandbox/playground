import { z } from "zod";
import { FatalError } from "../kit/errors";
import type { ActionContext, AgentResults, PlannedAction, RunContext, WorkflowDef } from "../kit/types";
import type { StripeClient, StripePaymentIntent, StripeSubscription } from "../providers/stripe";
import { stripeTime } from "../providers/stripe";
import type { ZendeskClient } from "../providers/zendesk";
import { Approvers, ChannelId, Email, money, out, plain, shortHash } from "./shared";

// Customer Experience · cx-retention.
// Trigger 1 (stage "request"): a customer asks to cancel by email or phone. Zendesk
//   creates the ticket for email; for a call the runtime opens it.
// Trigger 2 (stage "refund_choice"): the customer answers the refund offer on that
//   Zendesk ticket (a Zendesk trigger on the requester's reply, or a ticket field).

// ---------------------------------------------------------------------------
// Policy: what the research agent checks a request against. Reviewed like code.
// ---------------------------------------------------------------------------

export const POLICY = {
  version: "acme-cxl-2026-10",
  /** Subscription states that can still be cancelled. */
  cancellableStates: ["active", "trialing", "past_due", "unpaid", "incomplete"],
  /** Money-back window: the last payment is refunded in full, to any method. */
  fullRefundDays: 30,
  /** After that and up to here: the unused share of the period, as store credit or gift card only. */
  creditWindowDays: 90,
  /** Contract products commit for this long unless the product says otherwise. */
  defaultMinTermMonths: 12,
  /** Refunds above this wait for an approver; smaller ones are issued on the customer's choice. */
  autoRefundLimitMinor: 50_000,
  /** How long the customer has to pick a refund method. */
  offerValidDays: 30,
} as const;

export const METHODS = ["original_payment", "store_credit", "gift_card"] as const;
export type Method = (typeof METHODS)[number];
/** Fixed reply numbers, so "2" always means store credit whatever was offered. */
const NUMBER: Record<Method, number> = { original_payment: 1, store_credit: 2, gift_card: 3 };
const LABEL: Record<Method, string> = {
  original_payment: "Refund to your original payment method (5-10 business days)",
  store_credit: "ACME store credit, applied automatically to future invoices",
  gift_card: "ACME digital gift card",
};

export interface ProductTerms {
  cancellation: "self_serve" | "contract" | "not_cancellable";
  minTermMonths: number;
  refundable: boolean;
  methods: Method[];
}

/** Product-level terms from Stripe product metadata (`acme_cancellation`, `acme_min_term_months`, `acme_refundable`, `acme_refund_methods`). */
export function productTerms(meta: Record<string, string> = {}): ProductTerms {
  const c = meta.acme_cancellation;
  const cancellation = c === "contract" || c === "not_cancellable" ? c : "self_serve";
  const term = Number.parseInt(meta.acme_min_term_months ?? "", 10);
  const listed = (meta.acme_refund_methods ?? "").split(",").map((s) => s.trim()).filter((m): m is Method => (METHODS as readonly string[]).includes(m));
  return {
    cancellation,
    minTermMonths: Number.isFinite(term) && term >= 0 ? term : cancellation === "contract" ? POLICY.defaultMinTermMonths : 0,
    refundable: meta.acme_refundable !== "false",
    methods: listed.length ? listed : [...METHODS],
  };
}

export interface CancellationVerdict {
  /** cancel now (in policy) · exception (an approver must agree) · already (nothing to cancel) · refused (state can't be cancelled) */
  kind: "cancel" | "exception" | "already" | "refused";
  reason: string;
}

const PLAUSIBLE = Date.UTC(2000, 0, 1);
const DAY = 86_400_000;

function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.getTime();
}

export function cancellationVerdict(sub: { status: string; startedAt?: number }, terms: ProductTerms, now: number): CancellationVerdict {
  if (sub.status === "canceled" || sub.status === "incomplete_expired") return { kind: "already", reason: `subscription is already ${sub.status}` };
  if (!(POLICY.cancellableStates as readonly string[]).includes(sub.status)) return { kind: "refused", reason: `a ${sub.status} subscription can't be cancelled here` };
  if (terms.cancellation === "not_cancellable") return { kind: "exception", reason: "product is not cancellable under its terms" };
  if (terms.cancellation === "contract" && terms.minTermMonths > 0) {
    // Unknown start date: fail closed, a person checks the contract.
    if (!sub.startedAt) return { kind: "exception", reason: `contract start unknown (${terms.minTermMonths}-month commitment)` };
    const ends = addMonths(sub.startedAt, terms.minTermMonths);
    if (now < ends) return { kind: "exception", reason: `inside the ${terms.minTermMonths}-month commitment until ${new Date(ends).toISOString().slice(0, 10)}` };
  }
  return { kind: "cancel", reason: "cancellable under policy" };
}

export interface Payment {
  paymentIntent: string;
  amountMinor: number;
  refundedMinor: number;
  currency: string;
  paidAt: number;
  /** Has a charge Stripe can refund to the original method. */
  refundable: boolean;
}

export interface RefundOffer {
  tier: "full" | "prorated_credit" | "none";
  amountMinor: number;
  currency: string;
  methods: Method[];
  reason: string;
}

const PERIOD_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };

export function refundOffer(payment: Payment | undefined, interval: string | undefined, terms: ProductTerms, now: number, giftCards: { available: boolean; currency?: string }): RefundOffer {
  const none = (reason: string): RefundOffer => ({ tier: "none", amountMinor: 0, currency: payment?.currency ?? "usd", methods: [], reason });
  if (!terms.refundable) return none("product is non-refundable");
  if (!payment) return none("no payment found for this subscription");
  const remaining = payment.amountMinor - payment.refundedMinor;
  if (remaining <= 0) return none("last payment already refunded");
  const days = Math.floor((now - payment.paidAt) / DAY);
  const gift = giftCards.available && (!giftCards.currency || giftCards.currency.toLowerCase() === payment.currency.toLowerCase());
  const allowed = (ms: Method[]) => ms.filter((m) => terms.methods.includes(m) && (m !== "gift_card" || gift) && (m !== "original_payment" || payment.refundable));
  if (days <= POLICY.fullRefundDays) {
    const methods = allowed(["original_payment", "store_credit", "gift_card"]);
    return methods.length ? { tier: "full", amountMinor: remaining, currency: payment.currency, methods, reason: `paid ${days} day(s) ago, inside the ${POLICY.fullRefundDays}-day money-back window` } : none("no refund method available");
  }
  if (days <= POLICY.creditWindowDays) {
    const period = PERIOD_DAYS[interval ?? "month"] ?? 30;
    const unused = Math.floor(remaining * Math.max(0, 1 - days / period));
    const methods = allowed(["store_credit", "gift_card"]);
    if (unused <= 0) return none(`paid ${days} day(s) ago; nothing left of the ${interval ?? "billing"} period`);
    return methods.length ? { tier: "prorated_credit", amountMinor: unused, currency: payment.currency, methods, reason: `paid ${days} day(s) ago: unused share of the ${interval} period, as credit` } : none("no credit method available");
  }
  return none(`paid ${days} day(s) ago, outside the ${POLICY.creditWindowDays}-day refund window`);
}

/** The customer's answer to the offer: "2", "store credit", "gift card please"... Ambiguous answers are undefined. */
export function parseChoice(text: string): Method | undefined {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const hits = new Set<Method>();
  if (/ (1|one|option 1) /.test(t) || /original|credit card|debit card|my card|back to (my )?card|refund to (my )?card/.test(t)) hits.add("original_payment");
  if (/ (2|two|option 2) /.test(t) || /store credit|account credit|store card|credit balance/.test(t)) hits.add("store_credit");
  if (/ (3|three|option 3) /.test(t) || /gift ?card/.test(t)) hits.add("gift_card");
  return hits.size === 1 ? [...hits][0] : undefined;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const Customer = z.object({ email: Email, name: z.string().max(200).optional() });
const TicketId = z.number().int().positive();
const Shared = {
  customer: Customer,
  /** Ops channel for the case feed and approval requests. */
  opsChannel: ChannelId,
  /** Square location that issues ACME gift cards; without it gift cards are not offered. */
  giftCardLocationId: z.string().min(1).max(64).optional(),
  approvers: Approvers,
};

const RequestInput = z.object({
  stage: z.literal("request"),
  channel: z.enum(["email", "phone"]),
  /** The Zendesk ticket the email (or call) created. Opened by this runtime when absent. */
  ticketId: TicketId.optional(),
  /** Which subscription; otherwise the customer's only live one (optionally of `productId`). */
  subscriptionId: z.string().regex(/^sub_\w+$/, "Stripe subscription id like sub_123").optional(),
  productId: z.string().regex(/^prod_\w+$/, "Stripe product id like prod_123").optional(),
  /** What the customer wrote or said (untrusted). */
  message: z.string().min(1).max(4000),
  ...Shared,
});
const ChoiceInput = z.object({
  stage: z.literal("refund_choice"),
  ticketId: TicketId,
  /** From a Zendesk ticket field; otherwise read from the customer's latest public reply. */
  choice: z.enum(METHODS).optional(),
  ...Shared,
});
const Input = z.discriminatedUnion("stage", [RequestInput, ChoiceInput]);
type Input = z.infer<typeof Input>;
type Request = z.infer<typeof RequestInput>;
type Choice = z.infer<typeof ChoiceInput>;

// ---------------------------------------------------------------------------
// Agent outputs
// ---------------------------------------------------------------------------

interface TicketCtx {
  ticketId: number | null;
  requesterId: number | null;
  status: string | null;
  /** refund_choice: the method read from the customer's latest public reply. */
  replyChoice?: Method | null;
  replied?: boolean;
}
interface Research {
  customerId: string;
  subscriptionId: string;
  status: string;
  productId: string | null;
  productName: string;
  interval: string | null;
  startedAt: string | null;
  terms: ProductTerms;
  payment: Payment | null;
  verdict: CancellationVerdict;
}
/** What was promised at cancellation, read back from the subscription's metadata. */
interface Offer {
  customerId: string;
  subscriptionId: string;
  caseRef: string;
  requesterId: number | null;
  offeredAt: string;
  methods: Method[];
  amountMinor: number;
  currency: string;
  paymentIntent: string | null;
  /** Remaining refundable on the original payment now (it may have changed since the offer). */
  refundableNowMinor: number;
  alreadyRefunded: string | null;
}
interface GiftDesk {
  available: boolean;
  locationId: string | null;
  currency: string | null;
  reason: string;
}
interface Message {
  body: string;
  marker: string;
}
interface RequestDecision {
  stage: "request";
  caseRef: string;
  outcome: "cancel" | "exception" | "already" | "refused" | "unverified";
  reason: string;
  offer: RefundOffer | null;
  ack: Message;
  note: Message;
  customerReply: Message | null;
}
interface ChoiceDecision {
  stage: "refund_choice";
  caseRef: string;
  outcome: "refund" | "clarify" | "blocked";
  reason: string;
  method: Method | null;
  amountMinor: number;
  currency: string;
  needsApproval: boolean;
  note: Message;
  customerReply: Message | null;
}
type Decision = RequestDecision | ChoiceDecision;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One case per (ticket, customer); a call without a ticket keys on the trigger. */
export function caseRefFor(ticketId: number | undefined, email: string, runId: string): string {
  return `CXL-${shortHash(ticketId ? `zd:${ticketId}` : `run:${runId}`, email).slice(0, 8).toUpperCase()}`;
}

const META = {
  ref: "acme_cxl_ref",
  ticket: "acme_cxl_ticket",
  requester: "acme_cxl_requester",
  at: "acme_cxl_at",
  offer: "acme_cxl_offer",
  amount: "acme_cxl_amount",
  currency: "acme_cxl_currency",
  payment: "acme_cxl_payment",
  policy: "acme_cxl_policy",
  refund: "acme_cxl_refund",
} as const;
/** Customer metadata key pointing a ticket at the subscription it cancelled. */
const ticketKey = (ticketId: number | string) => `acme_cxl_${ticketId}`;

function firstName(input: Input): string {
  return plain(input.customer.name?.split(" ")[0] ?? "there", 60);
}

const signature = (marker: string) => `\n\nACME Customer Support · ref ${marker}`;
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Customer-facing text is code-written (it is posted without review), never model-written. */
function ackMessage(input: Request, caseRef: string, product: string): Message {
  const marker = `${caseRef}-ACK`;
  return {
    marker,
    body:
      `Hi ${firstName(input)},\n\nWe've received your request to cancel ${product}${input.channel === "phone" ? " from your call with us" : ""}. Here is what happens next:\n\n` +
      "1. We check your plan against ACME's cancellation and refund policy.\n" +
      "2. If the policy allows it, we cancel right away. If your plan has a commitment term, a team lead reviews the request first.\n" +
      "3. If a refund is due, we'll ask how you'd like to receive it: back to your original payment method, as ACME store credit, or as an ACME gift card.\n" +
      "4. You'll get a final confirmation once everything is done.\n\nThere's nothing you need to do right now." +
      signature(marker),
  };
}

function offerMessage(input: Request, caseRef: string, product: string, offer: RefundOffer, now: number): Message {
  const marker = `${caseRef}-OFFER`;
  const options = offer.methods.map((m) => `${NUMBER[m]} - ${LABEL[m]}`).join("\n");
  return {
    marker,
    body:
      `Hi ${firstName(input)},\n\nYour ${product} subscription is cancelled and you won't be charged again.\n\n` +
      `Under our refund policy you're eligible for ${money(offer.amountMinor, offer.currency)}. Please reply with the number of the option you'd like:\n\n${options}\n\n` +
      `This offer is open until ${date(now + POLICY.offerValidDays * DAY)}.` +
      signature(marker),
  };
}

function cancelledMessage(input: Request, caseRef: string, product: string, offer: RefundOffer): Message {
  const marker = `${caseRef}-DONE`;
  return {
    marker,
    body: `Hi ${firstName(input)},\n\nYour ${product} subscription is cancelled and you won't be charged again.\n\nNo refund is due under our refund policy (${offer.reason}). If you think that's wrong, just reply and a member of the team will look at it.` + signature(marker),
  };
}

function refundDoneMessage(input: Choice, caseRef: string, method: Method, amount: string): Message {
  const marker = `${caseRef}-REFUNDED`;
  const how: Record<Method, string> = {
    original_payment: `We've refunded ${amount} to your original payment method. Depending on your bank it shows up within 5-10 business days.`,
    store_credit: `We've added ${amount} of store credit to your ACME account. It's applied automatically to your next invoices.`,
    gift_card: `We've issued an ACME digital gift card worth ${amount}. The gift card number follows in a separate message.`,
  };
  return { marker, body: `Hi ${firstName(input)},\n\n${how[method]}\n\nThat completes your cancellation. Thank you for having been an ACME customer.` + signature(marker) };
}

function giftCardNumberMessage(input: Choice, caseRef: string, gan: string | null, giftCardId: string): Message {
  const marker = `${caseRef}-GIFTCARD`;
  const what = gan ? `Your gift card number is ${gan}.` : `Your gift card reference is ${giftCardId}; a team member will send the redemption number shortly.`;
  return { marker, body: `Hi ${firstName(input)},\n\n${what} Use it at checkout on any ACME order.` + signature(marker) };
}

function clarifyMessage(input: Choice, caseRef: string, runId: string, methods: Method[], unavailable?: Method): Message {
  const marker = `${caseRef}-ASK-${shortHash(runId).slice(0, 4).toUpperCase()}`;
  const opts = methods.map((m) => `${NUMBER[m]} - ${LABEL[m]}`).join("\n");
  const lead = unavailable ? `The ${LABEL[unavailable].toLowerCase()} option isn't available right now.` : "We couldn't tell which refund option you'd like.";
  return { marker, body: `Hi ${firstName(input)},\n\n${lead} Please reply with just the number of the option you prefer:\n\n${opts}` + signature(marker) };
}

/** Posts a ticket comment once: a retry (or a lost response) finds the comment by its marker instead of posting it again. */
async function commentOnce(zd: ZendeskClient, ticketId: number, msg: Message, isPublic: boolean, status?: "pending" | "solved"): Promise<string> {
  const prior = (await zd.listComments(ticketId)).find((c) => c.body?.includes(msg.marker));
  if (prior) return String(prior.id);
  await zd.addComment(ticketId, { body: msg.body, public: isPublic }, status);
  const posted = (await zd.listComments(ticketId)).find((c) => c.body?.includes(msg.marker));
  return posted ? String(posted.id) : `${ticketId}:${msg.marker}`;
}

async function commentReadBack(zd: ZendeskClient, ticketId: number, msg: Message) {
  const found = (await zd.listComments(ticketId)).find((c) => c.body?.includes(msg.marker));
  return found ? ({ status: "match" } as const) : ({ status: "missing", detail: `no comment carrying ${msg.marker}` } as const);
}

function ticketOf(input: Input, applied: ActionContext<Input>["applied"]): number {
  const id = input.ticketId ?? Number(applied["zendesk.create_ticket"]?.ref);
  if (!Number.isInteger(id) || id <= 0) throw new FatalError("no Zendesk ticket for this case (ticket creation failed)");
  return id;
}

/** The most recent successful payment for the subscription, and how much of it was refunded already. */
async function latestPayment(stripe: StripeClient, customerId: string, sub: StripeSubscription): Promise<Payment | null> {
  const pis = (await stripe.listPaymentIntents(customerId)).filter((p) => p.metadata?.subscription_id === sub.id);
  // Stripe's own link: the subscription's latest paid invoice and its payment.
  if (sub.latest_invoice) {
    const inv = await stripe.getInvoice(sub.latest_invoice);
    if (inv.status === "paid" && inv.payment_intent && !pis.some((p) => p.id === inv.payment_intent)) pis.push(await stripe.getPaymentIntent(inv.payment_intent));
  }
  const ok = pis.filter((p): p is StripePaymentIntent & { created: number | string } => p.status === "succeeded" && (!p.customer || p.customer === customerId) && stripeTime(p.created) !== undefined);
  const last = ok.sort((a, b) => stripeTime(b.created)! - stripeTime(a.created)! || a.id.localeCompare(b.id))[0];
  if (!last) return null;
  const refunds = await stripe.listRefundsForPaymentIntent(last.id);
  return {
    paymentIntent: last.id,
    amountMinor: last.amount_received ?? last.amount,
    refundedMinor: refunds.filter((r) => r.status !== "failed" && r.status !== "canceled").reduce((s, r) => s + r.amount, 0),
    currency: last.currency,
    paidAt: stripeTime(last.created)!,
    refundable: !!last.latest_charge,
  };
}

function plausible(...times: (number | string | null | undefined)[]): number | undefined {
  for (const t of times) {
    const ms = stripeTime(t);
    if (ms !== undefined && ms > PLAUSIBLE) return ms;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Agents (read-only)
// ---------------------------------------------------------------------------

async function researchRequest(input: Request, stripe: StripeClient, now: number): Promise<Research> {
  const customer = await stripe.findCustomerByEmail(input.customer.email);
  if (!customer) throw new FatalError(`no Stripe customer for ${input.customer.email}`);
  let sub: StripeSubscription;
  if (input.subscriptionId) {
    sub = await stripe.getSubscription(input.subscriptionId);
    // Only the requester's own subscription is ever cancelled.
    if (sub.customer !== customer.id) throw new FatalError(`${input.subscriptionId} does not belong to ${input.customer.email}`);
  } else {
    const live = (await stripe.listSubscriptions(customer.id)).filter((s) => s.customer === customer.id && s.status !== "canceled" && s.status !== "incomplete_expired");
    const product = (s: StripeSubscription) => {
      const p = s.items?.data?.[0]?.price as unknown;
      return typeof p === "object" && p ? (p as { product?: string }).product : undefined;
    };
    const matching = input.productId ? live.filter((s) => product(s) === input.productId) : live;
    if (matching.length !== 1) throw new FatalError(`${matching.length} live subscription(s) match; a person must pick which to cancel`);
    sub = matching[0]!;
  }
  const rawPrice = sub.items?.data?.[0]?.price as unknown;
  const price = typeof rawPrice === "string" ? await stripe.getPrice(rawPrice) : (rawPrice as (typeof sub.items.data)[number]["price"]);
  const productId = (price as { product?: string } | undefined)?.product ?? null;
  const product = productId ? await stripe.getProduct(productId) : undefined;
  const terms = productTerms(product?.metadata);
  const payment = await latestPayment(stripe, customer.id, sub);
  const startedAt = plausible(sub.start_date, sub.created, payment?.paidAt ? payment.paidAt / 1000 : undefined);
  return {
    customerId: customer.id,
    subscriptionId: sub.id,
    status: sub.status,
    productId,
    productName: plain(product?.name ?? "your ACME subscription", 80),
    interval: price?.recurring?.interval ?? null,
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    terms,
    payment,
    verdict: cancellationVerdict({ status: sub.status, startedAt }, terms, now),
  };
}

async function readOffer(input: Choice, stripe: StripeClient): Promise<Offer> {
  const customer = await stripe.findCustomerByEmail(input.customer.email);
  if (!customer) throw new FatalError(`no Stripe customer for ${input.customer.email}`);
  const subId = customer.metadata?.[ticketKey(input.ticketId)];
  if (!subId) throw new FatalError(`no cancellation on ticket ${input.ticketId} for ${input.customer.email}`);
  const sub = await stripe.getSubscription(subId);
  const m = sub.metadata ?? {};
  if (sub.customer !== customer.id || m[META.ticket] !== String(input.ticketId)) throw new FatalError(`${subId} was not cancelled on ticket ${input.ticketId}`);
  if (sub.status !== "canceled" && sub.status !== "incomplete_expired") throw new FatalError(`${subId} is ${sub.status}; refunds follow a completed cancellation`);
  const pi = m[META.payment] || null;
  let refundableNowMinor = 0;
  if (pi) {
    const p = await stripe.getPaymentIntent(pi);
    const refunded = (await stripe.listRefundsForPaymentIntent(pi)).filter((r) => r.status !== "failed" && r.status !== "canceled").reduce((s, r) => s + r.amount, 0);
    refundableNowMinor = p.latest_charge ? (p.amount_received ?? p.amount) - refunded : 0;
  }
  return {
    customerId: customer.id,
    subscriptionId: sub.id,
    caseRef: m[META.ref] || caseRefFor(input.ticketId, input.customer.email, ""),
    requesterId: m[META.requester] ? Number(m[META.requester]) : null,
    offeredAt: m[META.at] ?? "",
    methods: (m[META.offer] ?? "").split(",").filter((x): x is Method => (METHODS as readonly string[]).includes(x)),
    amountMinor: Number(m[META.amount] ?? 0),
    currency: m[META.currency] || "usd",
    paymentIntent: pi,
    refundableNowMinor,
    alreadyRefunded: m[META.refund] || null,
  };
}

// ---------------------------------------------------------------------------
// Decisions (compose stage, pure apart from the clock in ctx.startedAt)
// ---------------------------------------------------------------------------

function decideRequest(ctx: RunContext<Input>, input: Request, results: AgentResults): RequestDecision {
  const now = ctx.startedAt.getTime();
  const r = out<Research>(results, "policy-research");
  const desk = out<GiftDesk>(results, "gift-card-desk") ?? { available: false, locationId: null, currency: null, reason: "gift card system not connected" };
  const caseRef = caseRefFor(input.ticketId, input.customer.email, ctx.runId);
  const product = r?.productName ?? "your ACME subscription";
  const ack = ackMessage(input, caseRef, product);
  const noteMarker = `${caseRef}-POLICY`;
  if (!r) {
    const why = results.status["policy-research"] === "skipped" ? "billing system not connected" : "purchase could not be verified";
    return {
      stage: "request",
      caseRef,
      outcome: "unverified",
      reason: why,
      offer: null,
      ack,
      note: { marker: noteMarker, body: `Cancellation request ${caseRef}: ${why}. Nothing was cancelled; please verify the account and handle it manually.\nPolicy ${POLICY.version}.\n(ref ${noteMarker})` },
      customerReply: null,
    };
  }
  const offer = refundOffer(r.payment ?? undefined, r.interval ?? undefined, r.terms, now, { available: desk.available, currency: desk.currency ?? undefined });
  const v = r.verdict;
  const customerReply = v.kind === "cancel" || v.kind === "exception" ? (offer.tier === "none" ? cancelledMessage(input, caseRef, product, offer) : offerMessage(input, caseRef, product, offer, now)) : null;
  const lines = [
    `Cancellation request ${caseRef} (${input.channel}) checked against policy ${POLICY.version}.`,
    `Subscription ${r.subscriptionId} (${product}, ${r.status}${r.interval ? `, billed per ${r.interval}` : ""}); product terms: ${r.terms.cancellation}${r.terms.minTermMonths ? `, ${r.terms.minTermMonths}-month term` : ""}${r.terms.refundable ? "" : ", non-refundable"}.`,
    `Decision: ${v.kind === "cancel" ? "cancel now" : v.kind === "exception" ? "EXCEPTION - waiting for an approver before cancelling" : v.kind === "already" ? "nothing to cancel" : "cannot cancel automatically"} (${v.reason}).`,
    r.payment ? `Last payment ${r.payment.paymentIntent}: ${money(r.payment.amountMinor, r.payment.currency)} on ${date(r.payment.paidAt)}, ${money(r.payment.refundedMinor, r.payment.currency)} refunded so far.` : "No payment found for this subscription.",
    offer.tier === "none" ? `Refund: none (${offer.reason}).` : `Refund offer: ${money(offer.amountMinor, offer.currency)} (${offer.reason}); methods: ${offer.methods.join(", ")}.`,
    desk.available ? "" : `Gift cards not offered: ${desk.reason}.`,
    `(ref ${noteMarker})`,
  ];
  return { stage: "request", caseRef, outcome: v.kind, reason: v.reason, offer, ack, note: { marker: noteMarker, body: lines.filter(Boolean).join("\n") }, customerReply };
}

function decideChoice(ctx: RunContext<Input>, input: Choice, results: AgentResults): ChoiceDecision {
  const offer = out<Offer>(results, "policy-research");
  const ticket = out<TicketCtx>(results, "ticket-context");
  const desk = out<GiftDesk>(results, "gift-card-desk");
  const caseRef = offer?.caseRef ?? caseRefFor(input.ticketId, input.customer.email, ctx.runId);
  const noteMarker = `${caseRef}-REFUND-${shortHash(ctx.runId).slice(0, 4).toUpperCase()}`;
  const blocked = (reason: string): ChoiceDecision => ({
    stage: "refund_choice",
    caseRef,
    outcome: "blocked",
    reason,
    method: null,
    amountMinor: 0,
    currency: offer?.currency ?? "usd",
    needsApproval: false,
    note: { marker: noteMarker, body: `Refund choice on ${caseRef} not processed: ${reason}. A person needs to follow up.\n(ref ${noteMarker})` },
    customerReply: null,
  });
  if (!offer) return blocked(results.status["policy-research"] === "skipped" ? "billing system not connected" : "no matching cancellation for this customer and ticket");
  if (offer.alreadyRefunded && !offer.alreadyRefunded.startsWith("pending:")) return blocked(`already refunded (${offer.alreadyRefunded})`);
  if (!offer.methods.length || offer.amountMinor <= 0) return blocked("no refund was offered on this cancellation");
  const now = ctx.startedAt.getTime();
  const offeredAt = Date.parse(offer.offeredAt);
  if (!Number.isFinite(offeredAt) || now > offeredAt + POLICY.offerValidDays * DAY) return blocked(`the refund offer from ${offer.offeredAt.slice(0, 10) || "an unknown date"} has expired`);
  // The reply must come from the person who asked to cancel.
  if (ticket && offer.requesterId && ticket.requesterId && ticket.requesterId !== offer.requesterId) return blocked(`ticket requester ${ticket.requesterId} is not the customer who cancelled`);

  const choice = input.choice ?? ticket?.replyChoice ?? undefined;
  const giftReady = !!desk?.available;
  const usable = offer.methods.filter((m) => m !== "gift_card" || giftReady);
  const clarify = (reason: string, unavailable?: Method): ChoiceDecision => ({
    stage: "refund_choice",
    caseRef,
    outcome: "clarify",
    reason,
    method: null,
    amountMinor: offer.amountMinor,
    currency: offer.currency,
    needsApproval: false,
    note: { marker: noteMarker, body: `Refund choice on ${caseRef}: ${reason}; asked the customer again.\n(ref ${noteMarker})` },
    customerReply: clarifyMessage(input, caseRef, ctx.runId, usable, unavailable),
  });
  if (!choice) return clarify("no clear choice in the customer's reply");
  if (!offer.methods.includes(choice)) return clarify(`${choice} was not offered`);
  if (choice === "gift_card" && !giftReady) return usable.length ? clarify(`gift cards unavailable (${desk?.reason ?? "gift card system not connected"})`, "gift_card") : blocked("gift cards unavailable and no other method offered");

  // Re-confirm against the policy at refund time: never refund more than is still refundable.
  let amountMinor = offer.amountMinor;
  if (choice === "original_payment") {
    if (offer.refundableNowMinor <= 0) return usable.length > 1 ? clarify("the original payment can no longer be refunded", "original_payment") : blocked("the original payment can no longer be refunded");
    amountMinor = Math.min(amountMinor, offer.refundableNowMinor);
  }
  const needsApproval = amountMinor > POLICY.autoRefundLimitMinor;
  const amount = money(amountMinor, offer.currency);
  return {
    stage: "refund_choice",
    caseRef,
    outcome: "refund",
    reason: `${choice} chosen; ${amount}${needsApproval ? ` is above the ${money(POLICY.autoRefundLimitMinor, offer.currency)} auto-refund limit` : ""}`,
    method: choice,
    amountMinor,
    currency: offer.currency,
    needsApproval,
    note: { marker: noteMarker, body: `Refund on ${caseRef}: customer chose ${choice}; ${amount}${needsApproval ? ", waiting for approval" : ""}. Policy ${POLICY.version}.\n(ref ${noteMarker})` },
    customerReply: refundDoneMessage(input, caseRef, choice, amount),
  };
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export const productCancellation: WorkflowDef<Input> = {
  id: "product-cancellation",
  title: "Product cancellation and refund",
  org: "Customer Experience",
  team: "cx-retention",
  description:
    "Cancellation requests by email or phone: open or annotate the Zendesk ticket, acknowledge the customer, research the subscription against the cancellation and refund policy, cancel when the policy allows (exceptions wait for approval), offer the refund methods the policy allows and, when the customer picks one on the ticket, refund to the original payment (Stripe), as store credit (Stripe balance) or as a gift card (Square), then confirm on the ticket.",
  input: Input,
  agents: [
    {
      name: "ticket-context",
      needs: ["zendesk"],
      async run({ input, providers }) {
        if (!input.ticketId) return { summary: "no ticket yet: one will be opened", data: { ticketId: null, requesterId: null, status: null } satisfies TicketCtx };
        const zd = providers.zendesk!;
        const t = await zd.getTicket(input.ticketId);
        if (t.status === "closed") throw new FatalError(`ticket ${t.id} is closed`);
        const data: TicketCtx = { ticketId: t.id, requesterId: t.requester_id ?? null, status: t.status ?? null };
        if (input.stage === "refund_choice") {
          const replies = (await zd.listComments(t.id)).filter((c) => c.public && c.author_id === t.requester_id);
          const last = replies[replies.length - 1];
          data.replied = !!last;
          data.replyChoice = last?.body ? (parseChoice(last.body) ?? null) : null;
        }
        return { summary: `ticket ${t.id} (${t.status})${data.replied ? `, customer replied: ${data.replyChoice ?? "unclear"}` : ""}`, data };
      },
    },
    {
      name: "policy-research",
      needs: ["stripe"],
      async run({ input, providers, startedAt }) {
        if (input.stage === "refund_choice") {
          const o = await readOffer(input, providers.stripe!);
          return { summary: `${o.caseRef}: offered ${o.methods.join("/") || "nothing"} for ${money(o.amountMinor, o.currency)}${o.alreadyRefunded ? `; refund state ${o.alreadyRefunded}` : ""}`, data: o };
        }
        const r = await researchRequest(input, providers.stripe!, startedAt.getTime());
        return { summary: `${r.subscriptionId} (${r.productName}, ${r.status}): ${r.verdict.kind} - ${r.verdict.reason}`, data: r };
      },
    },
    {
      name: "gift-card-desk",
      needs: ["square"],
      async run({ input, providers }) {
        if (!input.giftCardLocationId) return { summary: "no gift card location configured", data: { available: false, locationId: null, currency: null, reason: "no gift card location configured" } satisfies GiftDesk };
        const loc = await providers.square!.getLocation(input.giftCardLocationId);
        const available = loc.status === "ACTIVE";
        const data: GiftDesk = { available, locationId: loc.id, currency: loc.currency ?? null, reason: available ? "location active" : `location ${loc.status ?? "unknown"}` };
        return { summary: `gift cards ${available ? "available" : "unavailable"} at ${loc.id}`, data };
      },
    },
  ],

  compose: {
    name: "case-decision",
    async run(ctx, results) {
      const d = ctx.input.stage === "request" ? decideRequest(ctx, ctx.input, results) : decideChoice(ctx, ctx.input, results);
      return { summary: `${d.caseRef}: ${d.outcome} (${d.reason})`, data: d };
    },
  },

  plan({ input }, results) {
    const d = out<Decision>(results, "case-decision");
    if (!d) return [];
    return d.stage === "request" ? planRequest(input as Request, d, results) : planChoice(input as Choice, d, results);
  },

  output({ input }, results) {
    const d = out<Decision>(results, "case-decision");
    const base = { stage: input.stage, caseRef: d?.caseRef ?? null, ticketId: input.ticketId ?? null, policyVersion: POLICY.version, decision: d?.outcome ?? "not decided", reason: d?.reason ?? null };
    if (d?.stage === "request") {
      const r = out<Research>(results, "policy-research");
      return { ...base, subscriptionId: r?.subscriptionId ?? null, cancellation: d.outcome, refundOffer: d.offer ? { tier: d.offer.tier, amountMinor: d.offer.amountMinor, currency: d.offer.currency, methods: d.offer.methods } : null };
    }
    if (d?.stage === "refund_choice") {
      const o = out<Offer>(results, "policy-research");
      return { ...base, subscriptionId: o?.subscriptionId ?? null, refundMethod: d.method, refundMinor: d.outcome === "refund" ? d.amountMinor : 0, currency: d.currency, needsApproval: d.needsApproval };
    }
    return base;
  },

  catalog: [
    { kind: "zendesk.create_ticket", provider: "zendesk", gate: "auto", description: "Open the ticket for a request that arrived by phone without one" },
    { kind: "zendesk.acknowledge", provider: "zendesk", gate: "auto", description: "Public reply (emailed by Zendesk) explaining the cancellation process" },
    { kind: "zendesk.policy_note", provider: "zendesk", gate: "auto", description: "Internal note with the policy research and the decision" },
    { kind: "stripe.cancel_subscription", provider: "stripe", gate: "auto", description: "Cancel the subscription when the policy allows it; recording the refund offer on it" },
    { kind: "stripe.cancel_subscription_exception", provider: "stripe", gate: "approval", description: "Cancel outside the policy (commitment term, non-cancellable product)" },
    { kind: "zendesk.refund_offer", provider: "zendesk", gate: "auto", description: "Public reply confirming the cancellation and asking the customer to pick a refund method (gated like the cancellation)" },
    { kind: "zendesk.cancellation_confirmed", provider: "zendesk", gate: "auto", description: "Public reply confirming a cancellation with no refund due; solves the ticket (gated like the cancellation)" },
    { kind: "slack.post_case", provider: "slack", gate: "auto", description: "Case feed in the ops channel, including exceptions waiting for approval" },
    { kind: "zendesk.clarify_choice", provider: "zendesk", gate: "auto", description: "Ask the customer again when the reply names no offered refund method" },
    { kind: "stripe.refund_original_payment", provider: "stripe", gate: "auto", description: "Refund to the original payment method; approval above the auto-refund limit" },
    { kind: "stripe.issue_store_credit", provider: "stripe", gate: "auto", description: "Credit the customer's Stripe balance; approval above the auto-refund limit" },
    { kind: "square.issue_gift_card", provider: "square", gate: "auto", description: "Create and activate a Square digital gift card; approval above the auto-refund limit" },
    { kind: "zendesk.refund_confirmation", provider: "zendesk", gate: "auto", description: "Public reply confirming the refund; solves the ticket (gated like the refund)" },
    { kind: "zendesk.gift_card_number", provider: "zendesk", gate: "auto", description: "Public reply with the gift card number (gift card refunds only)" },
    { kind: "slack.post_refund", provider: "slack", gate: "auto", description: "Refund feed in the ops channel" },
  ],
};

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

function slackPost(id: string, kind: string, channel: string, text: string, summary: Record<string, unknown>): PlannedAction<Input> {
  return {
    id,
    kind,
    provider: "slack",
    agent: "case-decision",
    gate: "auto",
    summary: { channel, ...summary },
    async execute({ providers }) {
      const m = await providers.slack!.postMessage(channel, text);
      return { ref: m.ts, detail: { channel: m.channel } };
    },
  };
}

function zendeskComment(id: string, input: Input, msg: Message, opts: { isPublic: boolean; gate?: "auto" | "approval"; status?: "pending" | "solved"; tags?: string[]; kind?: string }): PlannedAction<Input> {
  return {
    id,
    kind: opts.kind ?? id,
    provider: "zendesk",
    agent: "case-decision",
    gate: opts.gate ?? "auto",
    summary: { public: opts.isPublic, to: opts.isPublic ? input.customer.email : "internal", marker: msg.marker, status: opts.status ?? null, preview: msg.body.slice(0, 280) },
    async execute({ providers, applied }) {
      const zd = providers.zendesk!;
      const ticketId = ticketOf(input, applied);
      const ref = await commentOnce(zd, ticketId, msg, opts.isPublic, opts.status);
      if (opts.tags?.length) await zd.addTags(ticketId, opts.tags);
      return { ref, detail: { ticketId } };
    },
    async reconcile({ providers }, receipt) {
      return commentReadBack(providers.zendesk!, Number(receipt.detail?.ticketId), msg);
    },
  };
}

function planRequest(input: Request, d: RequestDecision, results: AgentResults): PlannedAction<Input>[] {
  const r = out<Research>(results, "policy-research");
  const t = out<TicketCtx>(results, "ticket-context");
  const actions: PlannedAction<Input>[] = [];

  if (!input.ticketId) {
    actions.push({
      id: "zendesk.create_ticket",
      kind: "zendesk.create_ticket",
      provider: "zendesk",
      agent: "case-decision",
      gate: "auto",
      summary: { requester: input.customer.email, channel: input.channel, externalId: d.caseRef },
      async execute({ providers }) {
        const zd = providers.zendesk!;
        // A retried trigger finds the ticket it opened instead of opening another.
        const prior = (await zd.findTicketsByExternalId(d.caseRef))[0];
        const tk =
          prior ??
          (await zd.createTicket({
            subject: `Cancellation request: ${r?.productName ?? "subscription"}`,
            body: `Cancellation requested by ${input.channel === "phone" ? "phone" : "email"}.\nCustomer said: ${plain(input.message, 3000)}`,
            requester: { email: input.customer.email, name: input.customer.name },
            tags: ["cancellation", `via_${input.channel}`],
            externalId: d.caseRef,
          }));
        return { ref: String(tk.id), detail: { requesterId: tk.requester_id ?? null, created: !prior } };
      },
    });
  }

  actions.push(zendeskComment("zendesk.acknowledge", input, d.ack, { isPublic: true, tags: ["cancellation", "cxl_acknowledged"] }));
  actions.push(zendeskComment("zendesk.policy_note", input, d.note, { isPublic: false }));

  const proceed = r && (d.outcome === "cancel" || d.outcome === "exception");
  if (r && proceed) {
    const gate = d.outcome === "cancel" ? "auto" : "approval";
    const offer = d.offer!;
    actions.push({
      id: "stripe.cancel_subscription",
      kind: gate === "auto" ? "stripe.cancel_subscription" : "stripe.cancel_subscription_exception",
      provider: "stripe",
      agent: "case-decision",
      gate,
      summary: { subscription: r.subscriptionId, product: r.productName, reason: d.reason, refundOffer: offer.tier === "none" ? "none" : `${money(offer.amountMinor, offer.currency)} via ${offer.methods.join("/")}` },
      async execute({ providers, applied, startedAt }) {
        const stripe = providers.stripe!;
        const ticketId = ticketOf(input, applied);
        const sub = await stripe.getSubscription(r.subscriptionId);
        if (sub.status === "canceled" || sub.status === "incomplete_expired") {
          if (sub.metadata?.[META.ref] === d.caseRef) return { ref: sub.id, detail: { status: sub.status, alreadyCancelled: true } };
          throw new FatalError(`${sub.id} was cancelled elsewhere (${sub.status}) before this case could`);
        }
        // The requester binds the later refund reply to this customer; re-read it if Zendesk was down during research.
        const requester =
          t?.requesterId ??
          (applied["zendesk.create_ticket"]?.detail?.requesterId as number | null | undefined) ??
          (await providers.zendesk?.getTicket(ticketId).catch(() => undefined))?.requester_id ??
          null;
        // The offer lives on the subscription so the refund stage (and reconcile) re-read it from Stripe, not from the trigger.
        await stripe.updateSubscriptionMetadata(sub.id, {
          [META.ref]: d.caseRef,
          [META.ticket]: String(ticketId),
          [META.requester]: requester ? String(requester) : "",
          [META.at]: startedAt.toISOString(),
          [META.offer]: offer.methods.join(","),
          [META.amount]: String(offer.amountMinor),
          [META.currency]: offer.currency,
          [META.payment]: r.payment?.paymentIntent ?? "",
          [META.policy]: POLICY.version,
        });
        await stripe.updateCustomerMetadata(r.customerId, { [ticketKey(ticketId)]: sub.id });
        const c = await stripe.cancelSubscription(sub.id);
        return { ref: c.id, detail: { status: c.status, ticketId } };
      },
      async reconcile({ providers }, receipt) {
        const s = await providers.stripe!.getSubscription(receipt.ref);
        if (s.status !== "canceled" && s.status !== "incomplete_expired") return { status: "drift", detail: `subscription is ${s.status} again` };
        return s.metadata?.[META.ref] === d.caseRef ? { status: "match" } : { status: "drift", detail: "cancellation record missing from the subscription" };
      },
    });
    if (offer.tier === "none") {
      actions.push(zendeskComment("zendesk.cancellation_confirmed", input, d.customerReply!, { isPublic: true, gate, status: "solved", tags: ["cxl_cancelled", "cxl_no_refund"] }));
    } else {
      // Tagged so a Zendesk trigger sends the customer's answer back here (stage refund_choice).
      actions.push(zendeskComment("zendesk.refund_offer", input, d.customerReply!, { isPublic: true, gate, status: "pending", tags: ["cxl_cancelled", "cxl_refund_offer"] }));
    }
  }

  const text = !r
    ? `:warning: ${d.caseRef}: cancellation request from ${input.customer.email} could not be verified (${d.reason}); nothing cancelled, needs a person.`
    : d.outcome === "cancel"
      ? `:white_check_mark: ${d.caseRef}: cancelling ${r.subscriptionId} (${r.productName}) for ${input.customer.email}; refund ${d.offer!.tier === "none" ? `none (${d.offer!.reason})` : `${money(d.offer!.amountMinor, d.offer!.currency)} offered`}.`
      : d.outcome === "exception"
        ? `:raised_hand: ${d.caseRef}: ${input.customer.email} asks to cancel ${r.subscriptionId} (${r.productName}) ${d.reason}. Approval needed before cancelling.`
        : `:information_source: ${d.caseRef}: ${input.customer.email} asked to cancel ${r.subscriptionId}: ${d.reason}. Nothing cancelled; needs a person.`;
  actions.push(slackPost("slack.post_case", "slack.post_case", input.opsChannel, text, { caseRef: d.caseRef, decision: d.outcome }));
  return actions;
}

function planChoice(input: Choice, d: ChoiceDecision, results: AgentResults): PlannedAction<Input>[] {
  const o = out<Offer>(results, "policy-research");
  const desk = out<GiftDesk>(results, "gift-card-desk");
  const actions: PlannedAction<Input>[] = [zendeskComment("zendesk.refund_note", input, d.note, { isPublic: false, kind: "zendesk.policy_note" })];

  if (d.outcome === "clarify") actions.push(zendeskComment("zendesk.clarify_choice", input, d.customerReply!, { isPublic: true, status: "pending" }));

  if (d.outcome === "refund" && o && d.method) {
    const gate = d.needsApproval ? "approval" : "auto";
    const method = d.method;
    const amount = money(d.amountMinor, d.currency);
    const meta = { acme_cxl_ref: d.caseRef, acme_cxl_ticket: String(input.ticketId) };
    const refundAction: Record<Method, Pick<PlannedAction<Input>, "id" | "provider" | "execute" | "reconcile">> = {
      original_payment: {
        id: "stripe.refund_original_payment",
        provider: "stripe",
        async execute({ providers, runId }) {
          const stripe = providers.stripe!;
          return guardedRefund(stripe, o, runId, method, async () => {
            const prior = (await stripe.listRefundsForPaymentIntent(o.paymentIntent!)).find((x) => x.metadata?.acme_cxl_ref === d.caseRef && x.status !== "failed" && x.status !== "canceled");
            const rf = prior ?? (await stripe.refundPaymentIntent(o.paymentIntent!, d.amountMinor, meta, `${d.caseRef}-refund`));
            return { ref: rf.id, detail: { amountMinor: rf.amount, status: rf.status, paymentIntent: o.paymentIntent } };
          });
        },
        async reconcile({ providers }, receipt) {
          const rf = await providers.stripe!.getRefund(receipt.ref);
          if (rf.status === "failed" || rf.status === "canceled") return { status: "drift", detail: `refund ${rf.status}` };
          return rf.amount === d.amountMinor ? { status: "match" } : { status: "drift", detail: `refund amount ${rf.amount}, expected ${d.amountMinor}` };
        },
      },
      store_credit: {
        id: "stripe.issue_store_credit",
        provider: "stripe",
        async execute({ providers, runId }) {
          const stripe = providers.stripe!;
          return guardedRefund(stripe, o, runId, method, async () => {
            const tx = await stripe.creditBalance(o.customerId, d.amountMinor, d.currency, `${d.caseRef} cancellation refund (store credit)`, `${d.caseRef}-credit`, meta);
            return { ref: tx.id, detail: { amountMinor: d.amountMinor, customer: o.customerId } };
          });
        },
        async reconcile({ providers }, receipt) {
          const tx = await providers.stripe!.getBalanceTransaction(o.customerId, receipt.ref);
          return Math.abs(Number(tx.amount)) === d.amountMinor ? { status: "match" } : { status: "drift", detail: `credit ${tx.amount}, expected -${d.amountMinor}` };
        },
      },
      gift_card: {
        id: "square.issue_gift_card",
        provider: "square",
        async execute({ providers, runId }) {
          const sq = providers.square!;
          const location = desk!.locationId!;
          return guardedRefund(providers.stripe!, o, runId, method, async () => {
            const card = await sq.createGiftCard(location, `${d.caseRef}-gc`);
            await sq.activateGiftCard(card.id, location, { amount: d.amountMinor, currency: d.currency.toUpperCase() }, d.caseRef, `${d.caseRef}-gc-activate`);
            // The full number goes to the customer only; run state keeps the last four digits.
            return { ref: card.id, detail: { amountMinor: d.amountMinor, ganLast4: card.gan ? card.gan.slice(-4) : null } };
          });
        },
        async reconcile({ providers }, receipt) {
          const card = await providers.square!.getGiftCard(receipt.ref);
          if (card.state !== "ACTIVE") return { status: "drift", detail: `gift card ${card.state}` };
          if (!card.balance_money) return { status: "unverifiable", detail: "gift card reports no balance" };
          return card.balance_money.amount === d.amountMinor ? { status: "match" } : { status: "drift", detail: `balance ${card.balance_money.amount}, expected ${d.amountMinor}` };
        },
      },
    };
    const a = refundAction[method];
    actions.push({ ...a, kind: a.id, agent: "case-decision", gate, summary: { caseRef: d.caseRef, method, amount, subscription: o.subscriptionId, needsApproval: d.needsApproval } });
    actions.push(zendeskComment("zendesk.refund_confirmation", input, d.customerReply!, { isPublic: true, gate, status: method === "gift_card" ? undefined : "solved", tags: ["cxl_refunded", `cxl_refund_${method}`] }));
    if (method === "gift_card") {
      actions.push({
        id: "zendesk.gift_card_number",
        kind: "zendesk.gift_card_number",
        provider: "zendesk",
        agent: "case-decision",
        gate,
        summary: { to: input.customer.email, caseRef: d.caseRef },
        async execute({ providers, applied }) {
          const cardId = applied["square.issue_gift_card"]?.ref;
          if (!cardId) throw new FatalError("gift card was not issued");
          const card = await providers.square!.getGiftCard(cardId);
          const msg = giftCardNumberMessage(input, d.caseRef, card.gan ?? null, card.id);
          return { ref: await commentOnce(providers.zendesk!, input.ticketId, msg, true, "solved"), detail: { ticketId: input.ticketId } };
        },
      });
    }
  }

  const text =
    d.outcome === "refund"
      ? `:moneybag: ${d.caseRef}: ${input.customer.email} chose ${d.method}; ${money(d.amountMinor, d.currency)}${d.needsApproval ? " - approval needed (above the auto-refund limit)" : " issued"}.`
      : d.outcome === "clarify"
        ? `:speech_balloon: ${d.caseRef}: ${d.reason}; asked ${input.customer.email} again.`
        : `:warning: ${d.caseRef}: refund for ${input.customer.email} not processed (${d.reason}); needs a person.`;
  actions.push(slackPost("slack.post_refund", "slack.post_refund", input.opsChannel, text, { caseRef: d.caseRef, decision: d.outcome, method: d.method }));
  return actions;
}

/**
 * One refund per cancellation, across runs: the subscription carries the
 * refund state. `pending:<run>` is written before money moves, so another run
 * (a second reply, a re-fired trigger) refuses rather than paying twice, and a
 * retry of this run carries on.
 */
async function guardedRefund(stripe: StripeClient, o: Offer, runId: string, method: Method, issue: () => Promise<{ ref: string; detail: Record<string, unknown> }>) {
  const state = (await stripe.getSubscription(o.subscriptionId)).metadata?.[META.refund];
  if (state && state !== `pending:${runId}`) throw new FatalError(`cancellation ${o.caseRef} already has a refund (${state})`);
  if (!state) await stripe.updateSubscriptionMetadata(o.subscriptionId, { [META.refund]: `pending:${runId}` });
  const receipt = await issue();
  await stripe.updateSubscriptionMetadata(o.subscriptionId, { [META.refund]: `${method}:${receipt.ref}` });
  return receipt;
}
