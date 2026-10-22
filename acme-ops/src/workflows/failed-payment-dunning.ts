import { z } from "zod";
import { FatalError, ProviderError } from "../kit/errors";
import type { PlannedAction, ProviderEvent, WorkflowDef } from "../kit/types";
import type { Providers } from "../providers";
import type { StripeInvoice } from "../providers/stripe";
import { stripeTime } from "../providers/stripe";
import { Approvers, ChannelId, Email, messageId, money, out, shortHash } from "./shared";

// Finance · billing-ops.
// Two entry points share one dunning ladder:
//   stage "payment_failed"  a signed Stripe `invoice.payment_failed` (webhook or AgentCore envelope);
//                           the invoice is re-read, the event is only a hint
//   stage "sweep"           daily: open invoices whose next step is due by age (the clock-driven half)
// Steps never go backwards, a paid or voided invoice stops the ladder, and the
// last step (cancelling the subscription) always waits for a person.

export const POLICY = {
  /** Days past the first failure at which each age-driven step starts. */
  finalNoticeAfterDays: 14,
  cancelAfterDays: 21,
  /** The account owner hears about failures on subscriptions worth at least this much per month. */
  escalateMrrMinor: 50_000,
  /** One backup card is tried automatically on the second failure. */
  retryBackupOnAttempt: 2,
  sweepMax: 200,
} as const;

/** Customer metadata key, per invoice, holding the last step taken: the ladder's memory. */
const stepKey = (invoice: string) => `acme_dunning_${invoice}`.slice(0, 40);

export type Step = "card_update_notice" | "reminder" | "final_notice" | "cancel";
const ORDER: Step[] = ["card_update_notice", "reminder", "final_notice", "cancel"];

const Common = { financeChannel: ChannelId, approvers: Approvers };
const PaymentFailed = z.object({
  stage: z.literal("payment_failed"),
  invoiceId: z.string().regex(/^in_\w+$/),
  eventId: z.string().max(255).optional(),
  ...Common,
});
const Sweep = z.object({
  stage: z.literal("sweep"),
  /** Customers in scope (from the billing system); never "everyone". */
  customers: z.array(Email).min(1).max(POLICY.sweepMax),
  ...Common,
});
const Input = z.discriminatedUnion("stage", [PaymentFailed, Sweep]);
type Input = z.infer<typeof Input>;

export interface InvoiceState {
  invoiceId: string;
  customerId: string;
  email: string | null;
  status: string;
  amountRemainingMinor: number;
  currency: string;
  attemptCount: number;
  /** When the invoice first became due (or was created), epoch ms. */
  dueMs: number | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  mrrMinor: number;
  lastStep: Step | null;
  backupPaymentMethod: string | null;
}
export interface Planned {
  invoice: InvoiceState;
  step: Step | null;
  retryBackup: boolean;
  escalate: boolean;
  why: string;
}

/** Which step an invoice is due for now. Pure: same invoice state and time → same step. */
export function nextStep(inv: InvoiceState, now: number): Planned {
  const none = (why: string): Planned => ({ invoice: inv, step: null, retryBackup: false, escalate: false, why });
  if (inv.status !== "open") return none(`invoice is ${inv.status}`);
  if (inv.amountRemainingMinor <= 0) return none("nothing left to collect");
  if (inv.attemptCount < 1) return none("no failed attempt yet");
  const days = inv.dueMs === null ? 0 : (now - inv.dueMs) / 86_400_000;
  let target: Step = inv.attemptCount >= 2 ? "reminder" : "card_update_notice";
  if (days >= POLICY.finalNoticeAfterDays || inv.attemptCount >= 3) target = "final_notice";
  if (days >= POLICY.cancelAfterDays) target = "cancel";
  if (target === "cancel" && (!inv.subscriptionId || inv.subscriptionStatus === "canceled")) target = "final_notice";
  // Never repeat or go back: a replayed or late event finds the ladder already further on.
  if (inv.lastStep && ORDER.indexOf(target) <= ORDER.indexOf(inv.lastStep)) return none(`already at ${inv.lastStep}`);
  return {
    invoice: inv,
    step: target,
    retryBackup: inv.attemptCount === POLICY.retryBackupOnAttempt && !!inv.backupPaymentMethod && target === "reminder",
    escalate: inv.mrrMinor >= POLICY.escalateMrrMinor && target !== "card_update_notice",
    why: `attempt ${inv.attemptCount}, ${Math.floor(days)} day(s) past due`,
  };
}

async function readInvoice(providers: Providers, inv: StripeInvoice): Promise<InvoiceState> {
  const stripe = providers.stripe!;
  const cus = await stripe.getCustomer(inv.customer);
  const sub = inv.subscription ? await stripe.getSubscription(inv.subscription) : undefined;
  const mrr = sub ? sub.items.data.reduce((s, it) => s + (it.price?.unit_amount ?? 0) * (it.quantity ?? 1) * (it.price?.recurring?.interval === "year" ? 1 / 12 : 1), 0) : 0;
  const cards = await stripe.listCardPaymentMethods(cus.id);
  const backup = cards.find((c) => c.id !== inv.default_payment_method);
  const last = cus.metadata?.[stepKey(inv.id)];
  return {
    invoiceId: inv.id,
    customerId: cus.id,
    email: cus.email,
    status: inv.status,
    amountRemainingMinor: inv.amount_remaining,
    currency: inv.currency,
    attemptCount: inv.attempt_count ?? 0,
    dueMs: stripeTime(inv.due_date) ?? stripeTime(inv.created) ?? null,
    subscriptionId: sub?.id ?? null,
    subscriptionStatus: sub?.status ?? null,
    mrrMinor: Math.round(mrr),
    lastStep: (ORDER as string[]).includes(last ?? "") ? (last as Step) : null,
    backupPaymentMethod: backup?.id ?? null,
  };
}

const NOTICE: Record<Exclude<Step, "cancel">, (amount: string, ref: string) => { subject: string; body: string }> = {
  card_update_notice: (amount, ref) => ({ subject: `Your payment of ${amount} didn't go through`, body: `Hello,\n\nWe couldn't charge your card for ${amount} (invoice ${ref}). Please update your payment method in Billing settings so your service continues without interruption.\n\nACME Billing` }),
  reminder: (amount, ref) => ({ subject: `Reminder: ${amount} is still outstanding`, body: `Hello,\n\nOur second attempt to collect ${amount} for invoice ${ref} also failed. Please update your payment method in Billing settings.\n\nACME Billing` }),
  final_notice: (amount, ref) => ({ subject: `Final notice: ${amount} overdue`, body: `Hello,\n\nInvoice ${ref} for ${amount} is overdue. If it stays unpaid, your subscription will be cancelled after a review by our billing team.\n\nACME Billing` }),
};

export const failedPaymentDunning: WorkflowDef<Input> = {
  id: "failed-payment-dunning",
  title: "Failed-payment dunning",
  org: "Finance",
  team: "billing-ops",
  description:
    "Walk a failed invoice up a dunning ladder from Stripe's signed invoice.payment_failed and a daily age sweep: card-update notice, reminder with one backup-card retry, final notice, then subscription cancellation with approval. Steps never repeat or go back and a paid invoice stops the ladder.",
  input: Input,

  events: {
    // The event names an invoice; its state is re-read. Each failed attempt is one run.
    async stripe(event: ProviderEvent, providers: Providers) {
      if (event.type !== "invoice.payment_failed") return null;
      const id = event.data?.object?.id;
      const channel = ChannelId.safeParse(process.env.DUNNING_SLACK_CHANNEL);
      if (typeof id !== "string" || !/^in_\w+$/.test(id) || !providers.stripe || !channel.success) return null;
      let inv: StripeInvoice;
      try {
        inv = await providers.stripe.getInvoice(id);
      } catch (err) {
        if (err instanceof ProviderError && err.status === 404) return null;
        throw err;
      }
      return { runId: `dunning-${id}-${inv.attempt_count ?? 0}`, input: { stage: "payment_failed", invoiceId: id, eventId: event.id, financeChannel: channel.data } };
    },
  },

  agents: [
    {
      name: "invoice-check",
      needs: ["stripe"],
      async run({ input, providers }) {
        const stripe = providers.stripe!;
        let invoices: StripeInvoice[];
        if (input.stage === "payment_failed") invoices = [await stripe.getInvoice(input.invoiceId)];
        else {
          invoices = [];
          for (const email of new Set(input.customers)) for (const c of await stripe.findCustomersByEmail(email)) invoices.push(...(await stripe.listInvoices(c.id, "open")));
        }
        const states: InvoiceState[] = [];
        for (const inv of invoices.slice(0, POLICY.sweepMax)) states.push(await readInvoice(providers, inv));
        return { summary: `${states.length} invoice(s), ${states.filter((s) => s.status === "open").length} open`, data: states };
      },
    },
  ],

  compose: {
    name: "dunning-plan",
    async run({ startedAt }, results) {
      const states = out<InvoiceState[]>(results, "invoice-check");
      const planned = (states ?? []).map((s) => nextStep(s, startedAt.getTime()));
      return { summary: states ? `${planned.filter((p) => p.step).length} step(s) due` : "blocked: invoices unreadable", data: { blocked: !states, planned } };
    },
  },

  plan({ input, runId }, results) {
    const p = out<{ blocked: boolean; planned: Planned[] }>(results, "dunning-plan");
    if (!p) return [];
    const actions: PlannedAction<Input>[] = [];
    for (const d of p.planned.filter((x) => x.step)) {
      const inv = d.invoice;
      const tag = shortHash(inv.invoiceId).slice(0, 10);
      const amount = money(inv.amountRemainingMinor, inv.currency);
      const stepId = `${d.step}:${inv.invoiceId}`;
      // Re-read at write time: a payment since the scan stops everything.
      const stillOpen = async (providers: Providers) => {
        const cur = await providers.stripe!.getInvoice(inv.invoiceId);
        if (cur.status !== "open" || cur.amount_remaining <= 0) throw new FatalError(`invoice is now ${cur.status}`);
      };

      if (d.retryBackup) {
        actions.push({
          id: `stripe.retry_backup:${inv.invoiceId}`,
          kind: "stripe.retry_backup",
          provider: "stripe",
          agent: "dunning-plan",
          gate: "auto",
          summary: { invoice: inv.invoiceId, amount },
          async execute({ providers }) {
            await stillOpen(providers);
            try {
              const paid = await providers.stripe!.payInvoice(inv.invoiceId, inv.backupPaymentMethod!, `dunning-retry-${inv.invoiceId}`);
              return { ref: paid.id, detail: { status: paid.status } };
            } catch (err) {
              // A decline is an outcome, not a failure of the step.
              if (err instanceof ProviderError && err.status === 402) return { ref: inv.invoiceId, detail: { status: "declined" } };
              throw err;
            }
          },
        });
      }

      if (d.step !== "cancel" && inv.email) {
        const n = NOTICE[d.step!](amount, inv.invoiceId);
        actions.push({
          id: `gmail.draft_${d.step}:${tag}`,
          kind: `gmail.draft_notice`,
          provider: "gmail",
          agent: "dunning-plan",
          gate: "auto",
          summary: { invoice: inv.invoiceId, step: d.step, sent: false },
          async execute({ providers, applied }) {
            const retried = applied[`stripe.retry_backup:${inv.invoiceId}`];
            if (retried?.detail?.status === "paid") return { ref: inv.invoiceId, detail: { skipped: "paid by backup card" } };
            await stillOpen(providers);
            // Another run (the sweep and an event on the same day) may have taken this step already.
            const done = (await providers.stripe!.getCustomer(inv.customerId)).metadata?.[stepKey(inv.invoiceId)];
            if (done && ORDER.indexOf(done as Step) >= ORDER.indexOf(d.step!)) return { ref: inv.invoiceId, detail: { skipped: `already at ${done}` } };
            const draft = await providers.gmail!.createDraft({ to: inv.email!, subject: n.subject, body: n.body, messageId: messageId(runId, `dunning-${d.step}-${tag}`) });
            return { ref: draft.id };
          },
        });
      }

      if (d.step === "cancel") {
        actions.push({
          id: `stripe.cancel_subscription:${inv.subscriptionId}`,
          kind: "stripe.cancel_subscription",
          provider: "stripe",
          agent: "dunning-plan",
          gate: "approval",
          summary: { invoice: inv.invoiceId, subscription: inv.subscriptionId, amount, why: d.why },
          async execute({ providers }) {
            await stillOpen(providers);
            const sub = await providers.stripe!.cancelSubscription(inv.subscriptionId!);
            return { ref: sub.id, detail: { status: sub.status } };
          },
        });
      }

      actions.push({
        id: `stripe.record_step:${inv.invoiceId}`,
        kind: "stripe.record_step",
        provider: "stripe",
        agent: "dunning-plan",
        gate: d.step === "cancel" ? "approval" : "auto",
        summary: { invoice: inv.invoiceId, step: d.step },
        async execute({ providers }) {
          const c = await providers.stripe!.updateCustomerMetadata(inv.customerId, { [stepKey(inv.invoiceId)]: d.step! });
          return { ref: c.id, detail: { step: d.step } };
        },
        async reconcile({ providers }) {
          const c = await providers.stripe!.getCustomer(inv.customerId);
          const cur = c.metadata?.[stepKey(inv.invoiceId)];
          return ORDER.indexOf(cur as Step) >= ORDER.indexOf(d.step!) ? { status: "match" } : { status: "drift", detail: `step is ${cur ?? "unset"}` };
        },
      });

      if (d.escalate || d.step === "cancel") {
        actions.push({
          id: `slack.escalate:${inv.invoiceId}`,
          kind: "slack.escalate",
          provider: "slack",
          agent: "dunning-plan",
          gate: "auto",
          summary: { channel: input.financeChannel, invoice: inv.invoiceId, step: d.step },
          async execute({ providers }) {
            const m = await providers.slack!.postMessage(input.financeChannel, `:credit_card: ${inv.invoiceId}: ${amount} unpaid (${d.why}); dunning step ${d.step}${d.step === "cancel" ? ", cancellation awaiting approval" : ""}. MRR ${money(inv.mrrMinor, inv.currency)}.`);
            return { ref: m.ts };
          },
        });
      }
    }
    if (p.blocked) {
      actions.push({
        id: "slack.escalate:blocked",
        kind: "slack.escalate",
        provider: "slack",
        agent: "dunning-plan",
        gate: "auto",
        summary: { channel: input.financeChannel, blocked: true },
        async execute({ providers }) {
          const m = await providers.slack!.postMessage(input.financeChannel, `:rotating_light: Dunning ${input.stage}: invoices could not be read; no customer was contacted.`);
          return { ref: m.ts };
        },
      });
    }
    return actions;
  },

  output(_ctx, results) {
    const p = out<{ blocked: boolean; planned: Planned[] }>(results, "dunning-plan");
    if (!p) return { mode: "not decided" };
    const due = p.planned.filter((x) => x.step);
    return { mode: p.blocked ? "blocked" : due.length ? "dunning" : "nothing", invoices: p.planned.length, steps: due.map((x) => `${x.invoice.invoiceId}:${x.step}`), skipped: p.planned.filter((x) => !x.step).map((x) => `${x.invoice.invoiceId}: ${x.why}`) };
  },

  catalog: [
    { kind: "stripe.retry_backup", provider: "stripe", gate: "auto", description: "Retry the invoice once with the customer's other saved card on the second failure" },
    { kind: "gmail.draft_notice", provider: "gmail", gate: "auto", description: "Draft (not send) the card-update notice, reminder or final notice" },
    { kind: "stripe.cancel_subscription", provider: "stripe", gate: "approval", description: "Cancel the subscription after the cancel threshold; always approved by a person" },
    { kind: "stripe.record_step", provider: "stripe", gate: "auto", description: "Record the step on the customer so the ladder never repeats or goes back" },
    { kind: "slack.escalate", provider: "slack", gate: "auto", description: "Tell finance about high-value failures, cancellations and unreadable invoices" },
  ],
};
