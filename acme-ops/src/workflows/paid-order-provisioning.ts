import { z } from "zod";
import { FatalError, ProviderError } from "../kit/errors";
import type { AgentResults, PlannedAction, ProviderEvent, WorkflowDef } from "../kit/types";
import type { Providers } from "../providers";
import type { StripeClient, StripePaymentIntent } from "../providers/stripe";
import { stripeTime } from "../providers/stripe";
import { Approvers, ChannelId, Email, messageId, money, out, shortHash } from "./shared";

// Sales · order-ops.
// Three entry points share one business rule: access is granted only for an
// order Stripe says is paid in full, never refunded or disputed.
//   stage "checkout"       charge a customer's saved card for seats (in-app purchase)
//   stage "payment_event"  a signed Stripe `payment_intent.succeeded` (webhook or AgentCore envelope)
//   stage "sweep"          find paid orders whose event never arrived and provision them

export const POLICY = {
  /** Per-seat one-time price in cents (USD). */
  prices: { team: 2_000, business: 4_500 } as Record<string, number>,
  currency: "usd",
  /** A charge above this waits for approval before the card is charged. */
  autoChargeMaxMinor: 500_000,
  /** Orders this large need an onboarding review before access is granted. */
  reviewSeatsAbove: 200,
  /** A provisioning claim older than this may be taken over by another run (crashed run). */
  claimStaleMinutes: 15,
} as const;

const Plan = z.enum(["team", "business"]);
const OrderId = z.string().regex(/^ORD-[\w-]{3,40}$/, "order id like ORD-2026-1001");
const Common = { opsChannel: ChannelId, approvers: Approvers };

const Checkout = z.object({
  stage: z.literal("checkout"),
  orderId: OrderId,
  customer: z.object({ email: Email, name: z.string().max(200).optional() }),
  plan: Plan,
  seats: z.number().int().min(1).max(5_000),
  /** WorkOS organization the seats belong to. */
  organizationId: z.string().regex(/^[\w-]{3,64}$/, "WorkOS organization id like org_01H..."),
  /** Saved payment method; defaults to the customer's invoice default. */
  paymentMethod: z.string().regex(/^pm_\w+$/).optional(),
  ...Common,
});
const PaymentEvent = z.object({
  stage: z.literal("payment_event"),
  paymentIntentId: z.string().regex(/^pi_\w+$/),
  /** The delivering event (for the record only: state is re-read from Stripe). */
  eventId: z.string().max(255).optional(),
  ...Common,
});
const Sweep = z.object({
  stage: z.literal("sweep"),
  /** Customers to check (from the order system); never "everyone". */
  customers: z.array(Email).min(1).max(200),
  /** Only orders paid at least this long ago, so a webhook in flight isn't raced. */
  minAgeMinutes: z.number().int().min(0).max(1_440).default(10),
  ...Common,
});
const Input = z.discriminatedUnion("stage", [Checkout, PaymentEvent, Sweep]);
type Input = z.infer<typeof Input>;

const META = { order: "acme_order", plan: "acme_plan", seats: "acme_seats", org: "acme_org", run: "acme_order_run", channel: "acme_ops_channel", claim: "acme_provisioning", done: "acme_provisioned", user: "acme_workos_user", membership: "acme_membership" } as const;

/** What a payment says about its order, verified against Stripe and the price list. Pure. */
export interface Order {
  orderId: string;
  paymentIntent: string;
  customerId: string;
  email: string | null;
  plan: string;
  seats: number;
  organizationId: string;
  amountMinor: number;
  currency: string;
  paidAt: string | null;
  status: string;
  refundedMinor: number;
  disputed: boolean;
  provisionedBy: string | null;
  claim: { run: string; at: number } | null;
}
export type Verdict = { provision: true; review: boolean; reason: string } | { provision: false; reason: string; already?: boolean };

export function verdictFor(o: Order, runId: string, now: number): Verdict {
  if (o.provisionedBy) return { provision: false, already: true, reason: `already provisioned by ${o.provisionedBy}` };
  if (o.status !== "succeeded") return { provision: false, reason: `payment is ${o.status}` };
  if (o.disputed) return { provision: false, reason: "payment is disputed" };
  if (o.refundedMinor > 0) return { provision: false, reason: `payment refunded (${money(o.refundedMinor, o.currency)})` };
  const price = POLICY.prices[o.plan];
  if (!price || !(o.seats > 0)) return { provision: false, reason: `unknown plan or seats (${o.plan} x ${o.seats})` };
  if (o.currency !== POLICY.currency || o.amountMinor !== price * o.seats) return { provision: false, reason: `paid ${money(o.amountMinor, o.currency)}, price is ${money(price * o.seats, POLICY.currency)}` };
  if (!o.email) return { provision: false, reason: "customer has no email" };
  if (o.claim && o.claim.run !== runId && now - o.claim.at < POLICY.claimStaleMinutes * 60_000) return { provision: false, reason: `being provisioned by ${o.claim.run}` };
  const review = o.seats > POLICY.reviewSeatsAbove;
  return { provision: true, review, reason: review ? `${o.seats} seats: onboarding review` : "paid in full" };
}

async function readOrder(stripe: StripeClient, pi: StripePaymentIntent, disputedCharges: Set<string>): Promise<Order | null> {
  const m = pi.metadata ?? {};
  if (!m[META.order]) return null;
  const customerId = typeof pi.customer === "string" ? pi.customer : "";
  const customer = customerId ? await stripe.getCustomer(customerId) : undefined;
  const refunded = (await stripe.listRefundsForPaymentIntent(pi.id)).filter((r) => r.status !== "failed" && r.status !== "canceled").reduce((s, r) => s + r.amount, 0);
  const paid = stripeTime(pi.created);
  const [run, at] = (m[META.claim] ?? "").split("@");
  return {
    orderId: m[META.order]!,
    paymentIntent: pi.id,
    customerId,
    email: customer?.email?.toLowerCase() ?? null,
    plan: m[META.plan] ?? "",
    seats: Number(m[META.seats] ?? 0),
    organizationId: m[META.org] ?? "",
    amountMinor: pi.amount_received ?? pi.amount,
    currency: pi.currency,
    paidAt: paid ? new Date(paid).toISOString() : null,
    status: pi.status,
    refundedMinor: refunded,
    disputed: !!pi.latest_charge && disputedCharges.has(pi.latest_charge),
    provisionedBy: m[META.done] || null,
    claim: run && at ? { run, at: Number(at) } : null,
  };
}

async function disputedCharges(stripe: StripeClient): Promise<Set<string>> {
  return new Set((await stripe.listDisputes()).map((d) => d.charge).filter((c): c is string => !!c));
}

interface CheckoutCheck {
  customerId: string;
  paymentMethod: string | null;
  existing: { paymentIntent: string; status: string } | null;
  amountMinor: number;
}
interface Orders {
  orders: (Order & { verdict: Verdict })[];
  notOurs: number;
}
interface Accounts {
  users: Record<string, string | null>;
}

export const orderRunId = (orderId: string) => `order-${orderId}`;

export const paidOrderProvisioning: WorkflowDef<Input> = {
  id: "paid-order-provisioning",
  title: "Paid order provisioning (Stripe events)",
  org: "Sales",
  team: "order-ops",
  description:
    "Charge a saved card for seats, then grant access only for an order Stripe says is paid in full: a signed payment_intent.succeeded webhook starts provisioning, the payment is re-read from Stripe instead of trusted, refunded, disputed or underpaid payments grant nothing, and a sweep provisions paid orders whose event never arrived. Access is a WorkOS membership; the CRM contact becomes a customer; the welcome is a draft.",
  input: Input,

  events: {
    // The event names a payment; everything else is read from Stripe. Every
    // delivery for one order maps to the same run, so redeliveries, replays and
    // concurrent deliveries are one run.
    async stripe(event: ProviderEvent, providers: Providers) {
      if (event.type !== "payment_intent.succeeded") return null;
      const id = event.data?.object?.id;
      if (typeof id !== "string" || !/^pi_\w+$/.test(id) || !providers.stripe) return null;
      let pi: StripePaymentIntent;
      try {
        pi = await providers.stripe.getPaymentIntent(id);
      } catch (err) {
        // A payment Stripe doesn't know is acknowledged and ignored; anything else is retried.
        if (err instanceof ProviderError && err.status === 404) return null;
        throw err;
      }
      const m = pi.metadata ?? {};
      if (!m[META.order] || !OrderId.safeParse(m[META.order]).success) return null;
      const channel = ChannelId.safeParse(m[META.channel]);
      if (!channel.success) return null;
      return { runId: orderRunId(m[META.order]!), input: { stage: "payment_event", paymentIntentId: id, eventId: event.id, opsChannel: channel.data }, labelsFromRun: m[META.run] };
    },
  },

  agents: [
    {
      name: "checkout-check",
      needs: ["stripe"],
      async run({ input, providers }) {
        if (input.stage !== "checkout") return { summary: "not a checkout", data: null };
        const stripe = providers.stripe!;
        const cus = await stripe.findCustomerByEmail(input.customer.email);
        if (!cus) throw new FatalError(`no Stripe customer for ${input.customer.email}`);
        const full = (await stripe.getCustomer(cus.id)) as { invoice_settings?: { default_payment_method?: string | null } };
        const prior = (await stripe.listPaymentIntents(cus.id)).find((p) => p.metadata?.[META.order] === input.orderId && p.status !== "canceled");
        const data: CheckoutCheck = {
          customerId: cus.id,
          paymentMethod: input.paymentMethod ?? full.invoice_settings?.default_payment_method ?? null,
          existing: prior ? { paymentIntent: prior.id, status: prior.status } : null,
          amountMinor: POLICY.prices[input.plan]! * input.seats,
        };
        return { summary: `${cus.id}: ${input.seats} ${input.plan} seat(s) = ${money(data.amountMinor)}${prior ? `, already charged (${prior.id})` : ""}`, data };
      },
    },
    {
      name: "payment-check",
      needs: ["stripe"],
      async run({ input, providers, runId, startedAt }) {
        if (input.stage === "checkout") return { summary: "not a payment", data: null };
        const stripe = providers.stripe!;
        const disputed = await disputedCharges(stripe);
        let pis: StripePaymentIntent[];
        if (input.stage === "payment_event") pis = [await stripe.getPaymentIntent(input.paymentIntentId)];
        else {
          const cutoff = startedAt.getTime() - input.minAgeMinutes * 60_000;
          pis = [];
          for (const email of [...new Set(input.customers)]) {
            const cus = await stripe.findCustomerByEmail(email);
            if (!cus) continue;
            pis.push(...(await stripe.listPaymentIntents(cus.id)).filter((p) => p.status === "succeeded" && p.metadata?.[META.order] && !p.metadata?.[META.done] && (stripeTime(p.created) ?? 0) <= cutoff));
          }
        }
        const orders: Orders["orders"] = [];
        let notOurs = 0;
        for (const pi of pis) {
          const o = await readOrder(stripe, pi, disputed);
          if (!o) {
            notOurs++;
            continue;
          }
          orders.push({ ...o, verdict: verdictFor(o, runId, startedAt.getTime()) });
        }
        if (input.stage === "payment_event" && !orders.length) throw new FatalError(`${input.paymentIntentId} is not an ACME order`);
        return { summary: orders.map((o) => `${o.orderId}: ${o.verdict.provision ? "provision" : "no"} (${o.verdict.reason})`).join("; ") || "no unprovisioned paid orders", data: { orders, notOurs } satisfies Orders };
      },
    },
    {
      name: "directory",
      needs: ["workos"],
      async run({ input, providers }) {
        if (input.stage === "checkout") return { summary: "not a payment", data: { users: {} } satisfies Accounts };
        // Resolved again at write time; this read only informs the plan and the record.
        const stripe = providers.stripe;
        const emails = new Set<string>();
        if (input.stage === "sweep") input.customers.forEach((e) => emails.add(e));
        else if (stripe) {
          const pi = await stripe.getPaymentIntent(input.paymentIntentId);
          const email = typeof pi.customer === "string" ? (await stripe.getCustomer(pi.customer)).email : null;
          if (email) emails.add(email.toLowerCase());
        }
        const users: Accounts["users"] = {};
        for (const e of emails) users[e] = (await providers.workos!.findUserByEmail(e))?.id ?? null;
        return { summary: `${Object.values(users).filter(Boolean).length}/${emails.size} already in the directory`, data: { users } satisfies Accounts };
      },
    },
  ],

  plan({ input, runId }, results) {
    if (input.stage === "checkout") return planCheckout(input, results, runId);
    return planProvisioning(input, results, runId);
  },

  output({ input }, results) {
    if (input.stage === "checkout") {
      const c = out<CheckoutCheck>(results, "checkout-check");
      return { stage: input.stage, orderId: input.orderId, amountMinor: c?.amountMinor ?? null, alreadyCharged: !!c?.existing, needsApproval: (c?.amountMinor ?? 0) > POLICY.autoChargeMaxMinor };
    }
    const o = out<Orders>(results, "payment-check");
    const orders = o?.orders ?? [];
    return {
      stage: input.stage,
      orders: orders.length,
      provisioned: orders.filter((x) => x.verdict.provision).map((x) => x.orderId),
      refused: orders.filter((x) => !x.verdict.provision && !("already" in x.verdict && x.verdict.already)).map((x) => ({ orderId: x.orderId, reason: x.verdict.reason })),
      alreadyProvisioned: orders.filter((x) => !x.verdict.provision && "already" in x.verdict && x.verdict.already).map((x) => x.orderId),
      review: orders.filter((x) => x.verdict.provision && x.verdict.review).map((x) => x.orderId),
    };
  },

  catalog: [
    { kind: "stripe.charge_order", provider: "stripe", gate: "auto", description: "Charge the saved card for the seats; approval above $5,000; never twice for one order" },
    { kind: "stripe.claim_order", provider: "stripe", gate: "auto", description: "Claim the paid order on the payment before granting access (another run's fresh claim stops this one)" },
    { kind: "workos.grant_access", provider: "workos", gate: "auto", description: "Find or create the buyer's WorkOS user and add the organization membership; approval above 200 seats" },
    { kind: "hubspot.mark_customer", provider: "hubspot", gate: "auto", description: "Upsert the CRM contact as a customer" },
    { kind: "gmail.draft_welcome", provider: "gmail", gate: "auto", description: "Draft (not send) the welcome email after access is granted" },
    { kind: "stripe.record_provisioned", provider: "stripe", gate: "auto", description: "Record on the payment which run provisioned it (the cross-run ledger)" },
    { kind: "slack.post_order", provider: "slack", gate: "auto", description: "Order feed in the ops channel, including refused and held orders" },
  ],
};

function slack(channel: string, text: string, summary: Record<string, unknown>, agent = "payment-check"): PlannedAction<Input> {
  return {
    id: "slack.post_order",
    kind: "slack.post_order",
    provider: "slack",
    agent,
    gate: "auto",
    summary: { channel, ...summary },
    async execute({ providers }) {
      const m = await providers.slack!.postMessage(channel, text);
      return { ref: m.ts, detail: { channel: m.channel } };
    },
  };
}

function planCheckout(input: z.infer<typeof Checkout>, results: AgentResults, runId: string): PlannedAction<Input>[] {
  const c = out<CheckoutCheck>(results, "checkout-check");
  if (!c) return [slack(input.opsChannel, `:warning: ${input.orderId}: checkout for ${input.customer.email} could not be verified; nothing charged.`, { orderId: input.orderId, charged: false }, "checkout-check")];
  if (c.existing) return [slack(input.opsChannel, `:information_source: ${input.orderId} was already charged (${c.existing.paymentIntent}, ${c.existing.status}); not charging again.`, { orderId: input.orderId, charged: false }, "checkout-check")];
  if (!c.paymentMethod) return [slack(input.opsChannel, `:warning: ${input.orderId}: ${input.customer.email} has no saved payment method; nothing charged.`, { orderId: input.orderId, charged: false }, "checkout-check")];
  const gate = c.amountMinor > POLICY.autoChargeMaxMinor ? "approval" : "auto";
  return [
    {
      id: "stripe.charge_order",
      kind: "stripe.charge_order",
      provider: "stripe",
      agent: "checkout-check",
      gate,
      summary: { orderId: input.orderId, customer: c.customerId, amount: money(c.amountMinor), seats: input.seats, plan: input.plan },
      async execute({ providers }) {
        const stripe = providers.stripe!;
        // The twin ignores Idempotency-Key, and a lost response must not charge twice: look first.
        const prior = (await stripe.listPaymentIntents(c.customerId)).find((p) => p.metadata?.[META.order] === input.orderId && p.status !== "canceled");
        const pi =
          prior ??
          (await stripe.chargeSavedMethod(
            {
              customer: c.customerId,
              amount: c.amountMinor,
              currency: POLICY.currency,
              paymentMethod: c.paymentMethod!,
              description: `${input.orderId}: ${input.seats} ${input.plan} seat(s)`,
              metadata: { [META.order]: input.orderId, [META.plan]: input.plan, [META.seats]: String(input.seats), [META.org]: input.organizationId, [META.run]: runId, [META.channel]: input.opsChannel },
            },
            `${input.orderId}-charge`,
          ));
        if (pi.status !== "succeeded" && pi.status !== "processing") throw new FatalError(`charge for ${input.orderId} is ${pi.status}`);
        return { ref: pi.id, detail: { status: pi.status, amountMinor: pi.amount, charge: pi.latest_charge ?? null, reused: !!prior } };
      },
      async reconcile({ providers }, receipt) {
        const pi = await providers.stripe!.getPaymentIntent(receipt.ref);
        return pi.amount === c.amountMinor && pi.metadata?.[META.order] === input.orderId ? { status: "match" } : { status: "drift", detail: `payment ${pi.amount} for ${pi.metadata?.[META.order]}` };
      },
    },
    slack(input.opsChannel, `:credit_card: ${input.orderId}: ${input.seats} ${input.plan} seat(s) for ${input.customer.email}, ${money(c.amountMinor)}${gate === "approval" ? " - charge waits for approval" : " charged"}. Access follows the payment event.`, { orderId: input.orderId, gate }, "checkout-check"),
  ];
}

function planProvisioning(input: Exclude<Input, { stage: "checkout" }>, results: AgentResults, runId: string): PlannedAction<Input>[] {
  const scan = out<Orders>(results, "payment-check");
  const actions: PlannedAction<Input>[] = [];
  if (!scan) return [slack(input.opsChannel, `:warning: ${input.stage === "payment_event" ? input.paymentIntentId : "sweep"}: payment could not be verified; no access granted.`, { verified: false })];
  for (const o of scan.orders.filter((x) => x.verdict.provision)) {
    const gate = o.verdict.provision && o.verdict.review ? "approval" : "auto";
    const key = o.orderId;
    actions.push({
      id: `stripe.claim_order:${key}`,
      kind: "stripe.claim_order",
      provider: "stripe",
      agent: "payment-check",
      gate,
      summary: { orderId: o.orderId, paymentIntent: o.paymentIntent },
      async execute({ providers, startedAt }) {
        const stripe = providers.stripe!;
        // Re-check at write time: refunded, disputed or claimed since the plan means no access.
        const fresh = await readOrder(stripe, await stripe.getPaymentIntent(o.paymentIntent), await disputedCharges(stripe));
        const v = fresh && verdictFor(fresh, runId, Date.now());
        if (!v || !v.provision) throw new FatalError(`${o.orderId} can no longer be provisioned: ${v?.reason ?? "not an order"}`);
        const mine = `${runId}@${startedAt.getTime()}`;
        await stripe.updatePaymentIntentMetadata(o.paymentIntent, { [META.claim]: mine });
        const after = (await stripe.getPaymentIntent(o.paymentIntent)).metadata?.[META.claim];
        if (after !== mine) throw new FatalError(`${o.orderId} was claimed by another run (${after})`);
        return { ref: o.paymentIntent, detail: { claim: mine } };
      },
    });
    actions.push({
      id: `workos.grant_access:${key}`,
      kind: "workos.grant_access",
      provider: "workos",
      agent: "payment-check",
      gate,
      summary: { orderId: o.orderId, user: shortHash("user", o.email!).slice(0, 10), organization: o.organizationId, role: "member", seats: o.seats },
      async execute({ providers, applied }) {
        if (!applied[`stripe.claim_order:${key}`]) throw new FatalError(`${o.orderId} not claimed by this run`);
        const wo = providers.workos!;
        const user = (await wo.findUserByEmail(o.email!)) ?? (await wo.createUser({ email: o.email!, first_name: o.email!.split("@")[0]!.slice(0, 40), external_id: o.customerId }));
        const membership = await wo.createMembership(user.id, o.organizationId, "member");
        return { ref: membership.id, detail: { userId: user.id } };
      },
      async reconcile({ providers }, receipt) {
        const m = await providers.workos!.getMembership(receipt.ref);
        return m.organization_id === o.organizationId && m.status !== "inactive" ? { status: "match" } : { status: "drift", detail: `membership ${m.status} in ${m.organization_id}` };
      },
    });
    actions.push({
      id: `hubspot.mark_customer:${key}`,
      kind: "hubspot.mark_customer",
      provider: "hubspot",
      agent: "payment-check",
      gate,
      summary: { orderId: o.orderId, lifecyclestage: "customer" },
      async execute({ providers }) {
        const r = await providers.hubspot!.upsertByEmail(o.email!, { lifecyclestage: "customer" });
        return { ref: r.contact.id, detail: { created: r.created } };
      },
    });
    actions.push({
      id: `gmail.draft_welcome:${key}`,
      kind: "gmail.draft_welcome",
      provider: "gmail",
      agent: "payment-check",
      gate,
      summary: { orderId: o.orderId, sent: false },
      async execute({ providers, applied }) {
        if (!applied[`workos.grant_access:${key}`]) throw new FatalError(`access for ${o.orderId} not granted yet`);
        const d = await providers.gmail!.createDraft({
          to: o.email!,
          subject: `Your ${o.seats} ACME ${o.plan} seat(s) are ready`,
          body: `Hello,\n\nThank you for your order ${o.orderId}. Your ${o.seats} ${o.plan} seat(s) are active: sign in to ACME to invite your team.\n\nACME`,
          messageId: messageId(runId, `welcome-${key}`),
        });
        return { ref: d.id };
      },
    });
    actions.push({
      id: `stripe.record_provisioned:${key}`,
      kind: "stripe.record_provisioned",
      provider: "stripe",
      agent: "payment-check",
      gate,
      summary: { orderId: o.orderId, paymentIntent: o.paymentIntent },
      async execute({ providers, applied }) {
        const grant = applied[`workos.grant_access:${key}`];
        if (!grant) throw new FatalError(`access for ${o.orderId} not granted yet`);
        await providers.stripe!.updatePaymentIntentMetadata(o.paymentIntent, { [META.done]: runId, [META.user]: String(grant.detail?.userId ?? ""), [META.membership]: grant.ref });
        return { ref: o.paymentIntent };
      },
      async reconcile({ providers }) {
        const pi = await providers.stripe!.getPaymentIntent(o.paymentIntent);
        return pi.metadata?.[META.done] === runId ? { status: "match" } : { status: "drift", detail: `provisioned marker is ${pi.metadata?.[META.done] ?? "missing"}` };
      },
    });
  }
  const granted = scan.orders.filter((o) => o.verdict.provision);
  const refused = scan.orders.filter((o) => !o.verdict.provision && !("already" in o.verdict && o.verdict.already));
  const already = scan.orders.length - granted.length - refused.length;
  if (!granted.length && !refused.length && input.stage === "sweep") return actions; // nothing missed: stay quiet
  const lines = [
    ...granted.map((o) => `${o.orderId} ${o.seats} ${o.plan} seat(s) ${o.verdict.provision && o.verdict.review ? "waiting for onboarding review" : "provisioned"}`),
    ...refused.map((o) => `${o.orderId} NOT provisioned: ${o.verdict.reason}`),
    ...(already ? [`${already} already provisioned`] : []),
  ];
  actions.push(slack(input.opsChannel, `${refused.length ? ":warning:" : ":white_check_mark:"} ${input.stage === "sweep" ? "Missed-event sweep" : "Payment event"}: ${lines.join("; ")}.`, { granted: granted.length, refused: refused.length, already }));
  return actions;
}
