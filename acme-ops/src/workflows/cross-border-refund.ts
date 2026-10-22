import { z } from "zod";
import { FatalError } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import type { StripeClient } from "../providers/stripe";
import { stripeTime } from "../providers/stripe";
import { Approvers, ChannelId, out, plain, shortHash } from "./shared";

// Customer Experience · global-support.
// Trigger: a refund request on a Zendesk ticket (the support form or an agent's
// macro names the ticket and the Stripe payment). The money goes back in the
// currency the customer paid, never converted, and only to the customer who
// paid. The amount comes from Stripe, never from the ticket's text.

/** Limits live in code: a trigger can't raise them. Amounts are in each currency's minor unit. */
export const POLICY = {
  /** Largest refund that goes out without approval, per currency. A currency not listed always needs approval. */
  autoRefundMaxMinor: { usd: 50_000, eur: 45_000, gbp: 40_000, chf: 45_000, cad: 65_000, aud: 75_000, jpy: 75_000, krw: 650_000 } as Record<string, number>,
  /** Older payments are refunded only with approval. */
  refundWindowDays: 180,
} as const;

/** Stripe's zero-decimal currencies: the amount is in whole units (¥500 is 500, not 50000). */
export const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
/** Three-decimal currencies: Stripe only accepts amounts that end in 0. */
export const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

export function exponent(currency: string): number {
  const c = currency.toLowerCase();
  return ZERO_DECIMAL.has(c) ? 0 : THREE_DECIMAL.has(c) ? 3 : 2;
}

/** "¥75,000", "45,00 €", "£400.00": the customer's own format for the currency they paid in. */
export function formatMoney(minor: number, currency: string, locale = "en-US"): string {
  const opts = { style: "currency", currency: currency.toUpperCase() } as const;
  const value = minor / 10 ** exponent(currency);
  try {
    return new Intl.NumberFormat(locale, opts).format(value);
  } catch {
    return new Intl.NumberFormat("en-US", opts).format(value);
  }
}

const Locale = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, "locale like de or pt-BR");

const Input = z.object({
  ticketId: z.number().int().positive(),
  paymentIntent: z.string().regex(/^pi_\w{6,64}$/, "Stripe payment intent id"),
  method: z.enum(["original_payment", "store_credit"]).default("original_payment"),
  /** Partial refund; the whole refundable remainder when omitted. */
  amountMinor: z.number().int().positive().max(1e12).optional(),
  /** The currency the request expects. Refunds are never converted, so a different one goes to a person. */
  currency: z.string().regex(/^[a-zA-Z]{3}$/).transform((c) => c.toLowerCase()).optional(),
  /** Overrides the requester's Zendesk locale for amounts in the reply. */
  locale: Locale.optional(),
  supportChannel: ChannelId,
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

/** Lines that address the automation instead of a person. Flagged, never obeyed. */
const INSTRUCTION_LIKE = /\b(ignore (all |any )?(previous|prior|above)|system\s*:|you are now|as an ai|approve (this|it|automatically)|override (the )?(policy|limit))/i;

export interface Ticket {
  ticketId: number;
  status: string | null;
  requesterEmail: string | null;
  requesterName: string | null;
  locale: string | null;
  /** The request text tries to instruct the automation. */
  suspicious: boolean;
  /** This payment's refund reply is already on the ticket (a re-run after a lost step). */
  replied: boolean;
}

export interface Payment {
  paymentIntent: string;
  status: string;
  currency: string;
  amountMinor: number;
  refundedMinor: number;
  creditedMinor: number;
  createdMs: number | null;
  customerId: string | null;
  customerEmail: string | null;
  /** The currency the customer's Stripe balance is kept in, when set. */
  balanceCurrency: string | null;
  disputed: boolean;
  /** A refund or credit this ticket already issued for this payment. */
  prior: { kind: "refund" | "store_credit"; ref: string; amountMinor: number } | null;
}

export interface Decision {
  mode: "refund" | "already_done" | "review" | "blocked";
  reason: string;
  method: "original_payment" | "store_credit";
  /** Why the requested method was not used. */
  fallback: string | null;
  amountMinor: number;
  currency: string;
  gate: "auto" | "approval";
  why: string;
  suspicious: boolean;
  locale: string;
}

/** Same ticket + payment → same reference, whichever run writes it. */
export const reference = (ticketId: number, paymentIntent: string) => `RF-${ticketId}-${shortHash(String(ticketId), paymentIntent).slice(0, 8).toUpperCase()}`;

/** The refund decision. Pure: reads Stripe's and Zendesk's facts, never the request text's claims. */
export function decide(input: Input, ticket: Ticket | undefined, payment: Payment | undefined, now: number): Decision {
  const locale = input.locale ?? ticket?.locale ?? "en-US";
  const base = { method: input.method, fallback: null, amountMinor: 0, currency: payment?.currency ?? input.currency ?? "usd", gate: "auto" as const, why: "", suspicious: ticket?.suspicious ?? false, locale };
  if (!ticket) return { ...base, mode: "blocked", reason: "ticket could not be read" };
  if (!payment) return { ...base, mode: "blocked", reason: "payment could not be read" };
  if (payment.prior) return { ...base, mode: "already_done", reason: `${payment.prior.kind} ${payment.prior.ref} already issued for this ticket`, method: payment.prior.kind === "refund" ? "original_payment" : "store_credit", amountMinor: payment.prior.amountMinor };
  const review = (reason: string): Decision => ({ ...base, mode: "review", reason });
  if (payment.status !== "succeeded") return review(`payment is ${payment.status}`);
  if (!ticket.requesterEmail || !payment.customerEmail || ticket.requesterEmail.toLowerCase() !== payment.customerEmail.toLowerCase()) return review("the ticket's requester is not the customer who paid");
  if (payment.disputed) return review("the payment is disputed; the card network decides, a refund would pay twice");
  if (input.currency && input.currency !== payment.currency) return review(`the request expects ${input.currency.toUpperCase()} but the payment was in ${payment.currency.toUpperCase()}; refunds are never converted`);
  const remaining = payment.amountMinor - payment.refundedMinor - payment.creditedMinor;
  if (remaining <= 0) return review("nothing left to refund on this payment");
  const amount = input.amountMinor ?? remaining;
  if (amount > remaining) return review(`requested ${formatMoney(amount, payment.currency)}, only ${formatMoney(remaining, payment.currency)} is refundable`);
  if (THREE_DECIMAL.has(payment.currency) && amount % 10 !== 0) return review(`${payment.currency.toUpperCase()} amounts must end in 0`);

  let method = input.method;
  let fallback: string | null = null;
  if (method === "store_credit" && payment.balanceCurrency && payment.balanceCurrency !== payment.currency) {
    method = "original_payment";
    fallback = `store credit is kept in ${payment.balanceCurrency.toUpperCase()}, the payment was in ${payment.currency.toUpperCase()}`;
  }

  const limit = POLICY.autoRefundMaxMinor[payment.currency];
  const ageDays = payment.createdMs === null ? null : (now - payment.createdMs) / 86_400_000;
  const gate = (why: string): Decision => ({ ...base, mode: "refund", reason: "eligible", method, fallback, amountMinor: amount, currency: payment.currency, gate: "approval", why });
  if (limit === undefined) return gate(`no automatic limit for ${payment.currency.toUpperCase()}`);
  if (amount > limit) return gate(`above the ${formatMoney(limit, payment.currency)} automatic limit`);
  if (ageDays === null) return gate("payment date unknown");
  if (ageDays > POLICY.refundWindowDays) return gate(`payment is older than ${POLICY.refundWindowDays} days`);
  if (ticket.suspicious) return gate("the request text tries to instruct the automation");
  return { ...base, mode: "refund", reason: "eligible", method, fallback, amountMinor: amount, currency: payment.currency, gate: "auto", why: "within limits" };
}

/** Refunds and credits that still count against the payment. */
const live = (s: string) => s !== "failed" && s !== "canceled";

async function refundState(stripe: StripeClient, input: Input) {
  const refunds = (await stripe.listRefundsForPaymentIntent(input.paymentIntent)).filter((r) => live(r.status));
  return { refunds, refundedMinor: refunds.reduce((s, r) => s + r.amount, 0) };
}

async function creditsFor(stripe: StripeClient, customer: string, paymentIntent: string) {
  const txns: { id: string; amount: number; metadata?: Record<string, string> | null }[] = await stripe.listBalanceTransactions(customer);
  return txns.filter((t) => t.metadata?.acme_payment === paymentIntent && t.amount < 0);
}

function replyBody(input: Input, d: Decision, ticket: Ticket, payment: Payment, ref: string): string {
  const amount = formatMoney(d.amountMinor, d.currency, d.locale);
  const cur = d.currency.toUpperCase();
  const partial = d.amountMinor < payment.amountMinor ? ` of your ${formatMoney(payment.amountMinor, d.currency, d.locale)} payment` : "";
  const hello = ticket.requesterName ? `Hello ${plain(ticket.requesterName, 80)},` : "Hello,";
  const what =
    d.method === "store_credit"
      ? `We've added ${amount}${partial} as store credit to your ACME account. It's kept in ${cur}, the currency you paid in, and is applied to your next invoice.`
      : `We've refunded ${amount}${partial} to the card or account you paid with. It goes back in ${cur}, the currency you paid in, so we don't convert it; it usually shows up within 5-10 business days.`;
  const why = d.fallback ? `\n\nYou asked for store credit, but your account balance is kept in ${payment.balanceCurrency!.toUpperCase()}, so we refunded the ${cur} payment to your original payment method instead of converting it.` : "";
  return `${hello}\n\n${what}${why}\n\nReference: ${ref}\n\nACME Support`;
}

export const crossBorderRefund: WorkflowDef<Input> = {
  id: "cross-border-refund",
  title: "Cross-border refund",
  org: "Customer Experience",
  team: "global-support",
  description:
    "Refund a Zendesk refund request in the currency the customer paid: the requester must be the paying customer, disputed or over-refunded payments go to a person, per-currency limits (zero- and three-decimal aware) gate approval, ticket text is never trusted for amounts, and store credit falls back to the card when the balance currency differs.",
  input: Input,
  agents: [
    {
      name: "ticket-intake",
      needs: ["zendesk"],
      async run({ input, providers }) {
        const zd = providers.zendesk!;
        const t = await zd.getTicket(input.ticketId);
        const user = t.requester_id ? await zd.getUser(t.requester_id) : undefined;
        const comments = await zd.listComments(input.ticketId);
        const ref = reference(input.ticketId, input.paymentIntent);
        // Read for one flag only: whether the text addresses the automation. Amounts never come from it.
        const fromRequester = [t.description ?? "", ...comments.filter((c) => c.public && (!t.requester_id || c.author_id === t.requester_id)).map((c) => c.body ?? "")];
        const data: Ticket = {
          ticketId: t.id,
          status: t.status ?? null,
          requesterEmail: user?.email?.toLowerCase() ?? null,
          requesterName: user?.name ?? null,
          locale: user?.locale && Locale.safeParse(user.locale).success ? user.locale : null,
          suspicious: fromRequester.some((b) => INSTRUCTION_LIKE.test(b)),
          replied: comments.some((c) => c.public && c.body?.includes(`Reference: ${ref}`)),
        };
        return { summary: `ticket ${t.id} (${t.status ?? "?"})${data.suspicious ? ", instruction-like text" : ""}`, data };
      },
    },
    {
      name: "payment-check",
      needs: ["stripe"],
      async run({ input, providers }) {
        const stripe = providers.stripe!;
        const pi = await stripe.getPaymentIntent(input.paymentIntent);
        const customer = pi.customer ? await stripe.getCustomer(pi.customer) : undefined;
        const { refunds, refundedMinor } = await refundState(stripe, input);
        const credits = customer ? await creditsFor(stripe, customer.id, pi.id) : [];
        // Fail closed: if disputes can't be listed the agent fails and nothing is refunded.
        const disputes = await stripe.listDisputes();
        const ticket = String(input.ticketId);
        const priorRefund = refunds.find((r) => r.metadata?.acme_ticket === ticket);
        const priorCredit = credits.find((c) => c.metadata?.acme_ticket === ticket);
        const data: Payment = {
          paymentIntent: pi.id,
          status: pi.status,
          currency: pi.currency.toLowerCase(),
          amountMinor: pi.amount_received ?? pi.amount,
          refundedMinor,
          creditedMinor: credits.reduce((s, c) => s - c.amount, 0),
          createdMs: stripeTime(pi.created) ?? null,
          customerId: customer?.id ?? null,
          customerEmail: customer?.email ?? null,
          balanceCurrency: (customer as { currency?: string | null } | undefined)?.currency?.toLowerCase() ?? null,
          disputed: disputes.some((x) => x.payment_intent === pi.id || (!!pi.latest_charge && x.charge === pi.latest_charge)),
          prior: priorRefund ? { kind: "refund", ref: priorRefund.id, amountMinor: priorRefund.amount } : priorCredit ? { kind: "store_credit", ref: priorCredit.id, amountMinor: -priorCredit.amount } : null,
        };
        return { summary: `${formatMoney(data.amountMinor, data.currency)} ${pi.status}, ${formatMoney(refundedMinor, data.currency)} refunded${data.disputed ? ", disputed" : ""}`, data };
      },
    },
  ],

  compose: {
    name: "refund-decision",
    async run({ input, startedAt }, results) {
      const d = decide(input, out<Ticket>(results, "ticket-intake"), out<Payment>(results, "payment-check"), startedAt.getTime());
      return { summary: `${d.mode}: ${d.mode === "refund" ? `${formatMoney(d.amountMinor, d.currency)} ${d.method} (${d.gate}: ${d.why})` : d.reason}`, data: d };
    },
  },

  plan({ input }, results) {
    const d = out<Decision>(results, "refund-decision");
    const ticket = out<Ticket>(results, "ticket-intake");
    const payment = out<Payment>(results, "payment-check");
    if (!d) return [];
    const ref = reference(input.ticketId, input.paymentIntent);
    const amount = formatMoney(d.amountMinor, d.currency);
    const actions: PlannedAction<Input>[] = [];
    const moneyId = d.method === "store_credit" ? `stripe.store_credit:${input.paymentIntent}` : `stripe.refund:${input.paymentIntent}`;

    if (d.mode === "refund" && payment) {
      const meta = { acme_ticket: String(input.ticketId), acme_reference: ref };
      if (d.method === "original_payment") {
        actions.push({
          id: moneyId,
          kind: "stripe.refund",
          provider: "stripe",
          agent: "refund-decision",
          gate: d.gate,
          summary: { ticket: input.ticketId, paymentIntent: input.paymentIntent, amount, currency: d.currency, why: d.why, ...(d.fallback ? { fallback: d.fallback } : {}) },
          async execute({ providers }) {
            const stripe = providers.stripe!;
            // The twin ignores Idempotency-Key on refunds and a retry may come from another run: look first.
            const { refunds, refundedMinor } = await refundState(stripe, input);
            const prior = refunds.find((r) => r.metadata?.acme_ticket === String(input.ticketId));
            if (prior) return { ref: prior.id, detail: { amountMinor: prior.amount, currency: prior.currency, reused: true } };
            const pi = await stripe.getPaymentIntent(input.paymentIntent);
            const remaining = (pi.amount_received ?? pi.amount) - refundedMinor - payment.creditedMinor;
            if (remaining < d.amountMinor) throw new FatalError(`${input.paymentIntent} now has ${remaining} refundable, planned ${d.amountMinor}`);
            const rf = await stripe.refundPaymentIntent(input.paymentIntent, d.amountMinor, meta, `refund-${input.ticketId}-${input.paymentIntent}`);
            return { ref: rf.id, detail: { amountMinor: rf.amount, currency: rf.currency, status: rf.status } };
          },
          async reconcile({ providers }, receipt) {
            const rf = await providers.stripe!.getRefund(receipt.ref);
            if (!live(rf.status)) return { status: "drift", detail: `refund ${rf.status}` };
            if (rf.currency.toLowerCase() !== d.currency) return { status: "drift", detail: `refund in ${rf.currency}, expected ${d.currency}` };
            return rf.amount === d.amountMinor ? { status: "match" } : { status: "drift", detail: `refund ${rf.amount}, expected ${d.amountMinor}` };
          },
        });
      } else {
        const customer = payment.customerId!;
        actions.push({
          id: moneyId,
          kind: "stripe.store_credit",
          provider: "stripe",
          agent: "refund-decision",
          gate: d.gate,
          summary: { ticket: input.ticketId, paymentIntent: input.paymentIntent, amount, currency: d.currency, why: d.why },
          async execute({ providers }) {
            const stripe = providers.stripe!;
            const credits = await creditsFor(stripe, customer, input.paymentIntent);
            const prior = credits.find((c) => c.metadata?.acme_ticket === String(input.ticketId));
            if (prior) return { ref: prior.id, detail: { amountMinor: -prior.amount, reused: true } };
            const { refundedMinor } = await refundState(stripe, input);
            const remaining = payment.amountMinor - refundedMinor - credits.reduce((s, c) => s - c.amount, 0);
            if (remaining < d.amountMinor) throw new FatalError(`${input.paymentIntent} now has ${remaining} refundable, planned ${d.amountMinor}`);
            const tx = await stripe.creditBalance(customer, d.amountMinor, d.currency, `Refund ${ref} as store credit`, `credit-${input.ticketId}-${input.paymentIntent}`, { ...meta, acme_payment: input.paymentIntent });
            return { ref: tx.id, detail: { amountMinor: Math.abs(tx.amount), currency: d.currency } };
          },
          async reconcile({ providers }, receipt) {
            const tx = await providers.stripe!.getBalanceTransaction(customer, receipt.ref);
            if (tx.currency?.toLowerCase() !== d.currency) return { status: "drift", detail: `credit in ${tx.currency}, expected ${d.currency}` };
            return tx.amount === -d.amountMinor ? { status: "match" } : { status: "drift", detail: `credit ${tx.amount}, expected ${-d.amountMinor}` };
          },
        });
      }
    }

    // The customer hears about money that moved, never about money that might.
    if ((d.mode === "refund" || d.mode === "already_done") && ticket && payment && !ticket.replied) {
      const body = replyBody(input, d, ticket, payment, ref);
      const needs = d.mode === "refund" ? moneyId : null;
      actions.push({
        id: `zendesk.reply:${input.ticketId}`,
        kind: "zendesk.reply",
        provider: "zendesk",
        agent: "refund-decision",
        gate: d.mode === "refund" ? d.gate : "auto",
        summary: { ticket: input.ticketId, public: true, amount: formatMoney(d.amountMinor, d.currency, d.locale), method: d.method, locale: d.locale, solves: true },
        async execute({ providers, applied }) {
          if (needs && !applied[needs]) throw new FatalError(`${needs} not applied`);
          const zd = providers.zendesk!;
          const existing = (await zd.listComments(input.ticketId)).find((c) => c.public && c.body?.includes(`Reference: ${ref}`));
          if (existing) return { ref: String(existing.id), detail: { reused: true } };
          const t = await zd.addComment(input.ticketId, { body, public: true }, "solved");
          return { ref: String(t.id), detail: { reference: ref, status: t.status } };
        },
      });
    }

    // Agents see the decision on the ticket; nothing here reaches the customer.
    if (ticket) {
      const note = [
        `Refund automation (${ref}): ${d.mode}${d.mode === "refund" ? ` ${amount} as ${d.method === "store_credit" ? "store credit" : "a refund to the original payment method"}` : ""}.`,
        d.mode === "refund" ? (d.gate === "approval" ? `Waiting for approval: ${d.why}.` : "Issued automatically within limits.") : `Reason: ${d.reason}.`,
        d.fallback ? `Store credit not used: ${d.fallback}.` : "",
        d.suspicious ? "The request text contains instructions aimed at the automation; they were ignored and the amount comes from Stripe." : "",
        d.mode === "review" || d.mode === "blocked" ? "No money moved. A person needs to follow up." : "",
      ].filter(Boolean);
      actions.push({
        id: `zendesk.internal_note:${input.ticketId}`,
        kind: "zendesk.internal_note",
        provider: "zendesk",
        agent: "refund-decision",
        gate: "auto",
        summary: { ticket: input.ticketId, public: false, mode: d.mode },
        async execute({ providers }) {
          const t = await providers.zendesk!.addComment(input.ticketId, { body: note.join("\n"), public: false });
          return { ref: String(t.id) };
        },
      });
    }

    const icon = d.mode === "refund" ? (d.gate === "approval" ? ":hourglass:" : ":currency_exchange:") : d.mode === "already_done" ? ":white_check_mark:" : ":warning:";
    const text = `${icon} Ticket ${input.ticketId} (${ref}): ${d.mode === "refund" ? `${amount} ${d.method === "store_credit" ? "store credit" : "refund"}${d.gate === "approval" ? `, needs approval (${d.why})` : ""}${d.fallback ? `; store credit not used (${d.fallback})` : ""}` : d.reason}.${d.suspicious ? " Request text tried to instruct the automation." : ""}`;
    actions.push({
      id: "slack.post_refund",
      kind: "slack.post_refund",
      provider: "slack",
      agent: "refund-decision",
      gate: "auto",
      summary: { channel: input.supportChannel, mode: d.mode },
      async execute({ providers }) {
        const m = await providers.slack!.postMessage(input.supportChannel, text);
        return { ref: m.ts, detail: { channel: m.channel } };
      },
    });
    return actions;
  },

  output(_ctx, results) {
    const d = out<Decision>(results, "refund-decision");
    if (!d) return { mode: "not decided" };
    return { mode: d.mode, reason: d.reason, method: d.method, fallback: d.fallback, amountMinor: d.amountMinor, currency: d.currency, amount: formatMoney(d.amountMinor, d.currency, d.locale), gate: d.gate, why: d.why, suspicious: d.suspicious };
  },

  catalog: [
    { kind: "stripe.refund", provider: "stripe", gate: "auto", description: "Refund the payment in its own currency; approval above the currency's limit, for old payments or instruction-like request text" },
    { kind: "stripe.store_credit", provider: "stripe", gate: "auto", description: "Credit the customer's Stripe balance instead, only in the balance's own currency" },
    { kind: "zendesk.reply", provider: "zendesk", gate: "auto", description: "Public reply with the locale-formatted amount, solving the ticket, only after the money moved" },
    { kind: "zendesk.internal_note", provider: "zendesk", gate: "auto", description: "Internal note with the decision for support agents" },
    { kind: "slack.post_refund", provider: "slack", gate: "auto", description: "Decision in the support channel" },
  ],
};

