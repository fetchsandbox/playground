import { z } from "zod";
import { firstFreeSlot, type Slot } from "../providers/google";
import { EXISTING_SUB_STATES } from "../providers/stripe";
import { FatalError } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { Approvers, ChannelId, Email, messageId, money, out, plain } from "./shared";

// Sales → Customer Success handoff · sales-ops team.
// Trigger: a deal moves to closed-won in the CRM.

const Input = z.object({
  dealId: z.string().min(1).max(100),
  company: z.string().min(1).max(200),
  contact: z.object({ email: Email, firstname: z.string().min(1).max(100), lastname: z.string().max(100).optional() }),
  plan: z.object({ priceId: z.string().regex(/^price_\w+$/), quantity: z.number().int().min(1).max(10_000) }),
  onboardingChannel: ChannelId,
  csmCalendarId: z.string().min(1).default("primary"),
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

interface CrmState {
  contactId?: string;
  lifecycle?: string;
}
interface BillingState {
  customerId?: string;
  duplicateCustomers: number;
  price: { id: string; currency: string; unitAmountMinor: number; interval: string };
  /** A subscription to this price already exists, live or awaiting first payment (e.g. a re-fired trigger). */
  existingSubscriptionId?: string;
}
interface SupportState {
  userId?: number;
}
interface Kickoff {
  slot?: Slot;
}
interface Welcome {
  subject: string;
  body: string;
  draftedBy: string;
  mrrMinor: number;
}

export const onboardingKickoff: WorkflowDef<Input> = {
  id: "onboarding-kickoff",
  title: "Onboarding kickoff",
  org: "Sales",
  team: "sales-ops",
  description:
    "On closed-won: make the buyer a HubSpot customer, ensure a Stripe customer, provision Zendesk, draft the welcome email and hand off in Slack. Starting the subscription and inviting the customer to kickoff wait for approval.",
  input: Input,
  agents: [
    {
      name: "crm-check",
      needs: ["hubspot"],
      async run({ input, providers }) {
        const c = await providers.hubspot!.findByEmail(input.contact.email);
        return { summary: c ? `contact ${c.id} (${c.properties.lifecyclestage ?? "no stage"})` : "new contact", data: { contactId: c?.id, lifecycle: c?.properties.lifecyclestage ?? undefined } satisfies CrmState };
      },
    },
    {
      name: "billing-check",
      needs: ["stripe"],
      async run({ input, providers }) {
        const stripe = providers.stripe!;
        const [price, customer] = await Promise.all([stripe.getPrice(input.plan.priceId), stripe.findCustomerByEmail(input.contact.email)]);
        if (!price.active || price.unit_amount == null || !price.recurring) {
          // Never put a customer on a price that isn't a live recurring price.
          throw new FatalError(`price ${input.plan.priceId} is not an active recurring price`);
        }
        let existing: string | undefined;
        let dup = 0;
        if (customer) {
          const all = (await stripe.listCustomers()).filter((c) => c.email?.toLowerCase() === input.contact.email);
          dup = Math.max(0, all.length - 1);
          const subs = (await stripe.listSubscriptions(customer.id)).filter((s) => s.customer === customer.id && EXISTING_SUB_STATES.has(s.status));
          existing = subs.find((s) => s.items.data.some((it) => it.price?.id === price.id))?.id;
        }
        const data: BillingState = {
          customerId: customer?.id,
          duplicateCustomers: dup,
          price: { id: price.id, currency: price.currency, unitAmountMinor: price.unit_amount, interval: price.recurring.interval },
          existingSubscriptionId: existing,
        };
        return { summary: `${customer ? `customer ${customer.id}` : "new customer"}; ${money(price.unit_amount, price.currency)}/${price.recurring.interval}${existing ? `; already subscribed (${existing})` : ""}`, data };
      },
    },
    {
      name: "support-check",
      needs: ["zendesk"],
      async run({ input, providers }) {
        const found = await providers.zendesk!.searchTickets(`requester:${input.contact.email}`, 1);
        return { summary: found.length ? "requester already known to Zendesk" : "new to Zendesk", data: { userId: found[0]?.requester_id } satisfies SupportState };
      },
    },
    {
      name: "kickoff-scheduler",
      needs: ["calendar"],
      async run({ input, providers, startedAt }) {
        const busy = await providers.calendar!.busy(input.csmCalendarId, startedAt.toISOString(), new Date(startedAt.getTime() + 14 * 86_400_000).toISOString());
        const slot = firstFreeSlot(busy, startedAt, 60, 7);
        return { summary: slot ? `kickoff ${slot.start}` : "no free hour in 7 business days", data: { slot } satisfies Kickoff };
      },
    },
  ],

  compose: {
    name: "welcome-composer",
    async run({ input, drafter }, results) {
      const bill = out<BillingState>(results, "billing-check");
      const slot = out<Kickoff>(results, "kickoff-scheduler")?.slot;
      const mrrMinor = bill ? bill.price.unitAmountMinor * input.plan.quantity : 0;
      const d = await drafter.draft({
        task: "welcome-email",
        instructions: "Draft a welcome email to a new customer from their ACME onboarding team: thank them, name the plan size, propose the kickoff time if one is given, and list two things to prepare. Do not quote prices.",
        facts: { firstName: input.contact.firstname, company: input.company, seats: input.plan.quantity, kickoff: slot?.start ?? null },
        fallback: {
          subject: `Welcome to ACME, ${plain(input.company, 80)}`,
          body: `Hi ${input.contact.firstname},\n\nWelcome aboard, and thank you for choosing ACME for ${input.plan.quantity} seat(s).\n\n${slot ? `We've proposed a kickoff for ${slot.start} (UTC); an invitation will follow.` : "We'll propose a kickoff time shortly."}\nTo prepare, please share your admin contacts and your top three goals for the first 90 days.\n\nThe ACME onboarding team`,
        },
      });
      return { summary: `welcome drafted by ${d.draftedBy}`, data: { ...d, mrrMinor } satisfies Welcome };
    },
  },

  plan({ input }, results) {
    const crm = out<CrmState>(results, "crm-check");
    const bill = out<BillingState>(results, "billing-check");
    const slot = out<Kickoff>(results, "kickoff-scheduler")?.slot;
    const welcome = out<Welcome>(results, "welcome-composer");
    const actions: PlannedAction<Input>[] = [];
    const name = [input.contact.firstname, input.contact.lastname].filter(Boolean).join(" ");

    if (crm) {
      actions.push({
        id: "hubspot.upsert_customer",
        kind: "hubspot.upsert_customer",
        provider: "hubspot",
        agent: "crm-check",
        gate: "auto",
        summary: { email: input.contact.email, set: { lifecyclestage: "customer", company: input.company }, existing: crm.contactId ?? null },
        async execute({ providers }) {
          const props: Record<string, string> = { firstname: input.contact.firstname, company: input.company, lifecyclestage: "customer" };
          if (input.contact.lastname) props.lastname = input.contact.lastname;
          const { contact, created } = await providers.hubspot!.upsertByEmail(input.contact.email, props);
          return { ref: contact.id, detail: { created } };
        },
        async reconcile({ providers }, receipt) {
          const c = await providers.hubspot!.get(receipt.ref);
          return c.properties.lifecyclestage === "customer" ? { status: "match" } : { status: "drift", detail: `lifecyclestage is ${c.properties.lifecyclestage}` };
        },
      });
    }

    // Billing needs a readable, valid price; without it nothing is created in Stripe.
    if (bill) {
      actions.push({
        id: "stripe.ensure_customer",
        kind: "stripe.ensure_customer",
        provider: "stripe",
        agent: "billing-check",
        gate: "auto",
        summary: { email: input.contact.email, existing: bill.customerId ?? null },
        async execute({ providers, runId }) {
          if (bill.customerId) return { ref: bill.customerId, detail: { created: false } };
          // Re-check at write time: another run may have created it since the agent looked.
          const again = await providers.stripe!.findCustomerByEmail(input.contact.email);
          if (again) return { ref: again.id, detail: { created: false } };
          const c = await providers.stripe!.createCustomer(input.contact.email, name, { deal_id: input.dealId, company: input.company }, `onboard-${runId}-customer`);
          return { ref: c.id, detail: { created: true } };
        },
        async reconcile({ providers }, receipt) {
          const c = await providers.stripe!.getCustomer(receipt.ref);
          return c.email?.toLowerCase() === input.contact.email ? { status: "match" } : { status: "drift", detail: `customer email is ${c.email}` };
        },
      });
    }

    actions.push({
      id: "zendesk.provision_requester",
      kind: "zendesk.provision_requester",
      provider: "zendesk",
      agent: "support-check",
      gate: "auto",
      summary: { organization: input.company, email: input.contact.email },
      async execute({ providers }) {
        const org = await providers.zendesk!.createOrUpdateOrganization(input.company, `deal:${input.dealId}`);
        const user = await providers.zendesk!.createOrUpdateUser(input.contact.email, name, org.id);
        return { ref: String(user.id), detail: { organizationId: org.id } };
      },
    });

    if (welcome) {
      actions.push({
        id: "gmail.draft_welcome",
        kind: "gmail.draft_welcome",
        provider: "gmail",
        agent: "welcome-composer",
        gate: "auto",
        summary: { to: input.contact.email, subject: welcome.subject, draftedBy: welcome.draftedBy, sent: false },
        async execute({ providers, runId }) {
          const d = await providers.gmail!.createDraft({ to: input.contact.email, subject: welcome.subject, body: welcome.body, messageId: messageId(runId, "welcome") });
          return { ref: d.id };
        },
      });
    }

    actions.push({
      id: "slack.post_handoff",
      kind: "slack.post_handoff",
      provider: "slack",
      agent: "welcome-composer",
      gate: "auto",
      summary: { channel: input.onboardingChannel, dealId: input.dealId },
      async execute({ providers }) {
        const text = [
          `:tada: Closed-won *${plain(input.company, 100)}* (deal ${plain(input.dealId, 60)}) — ${input.plan.quantity} × ${input.plan.priceId}${welcome ? ` ≈ ${money(welcome.mrrMinor, bill?.price.currency)}/${bill?.price.interval ?? "period"}` : ""}.`,
          `Buyer: ${input.contact.email}. Kickoff: ${slot?.start ?? "to be scheduled"}.`,
          bill?.existingSubscriptionId ? `Already subscribed (${bill.existingSubscriptionId}); no new subscription will be created.` : "Subscription start is waiting for approval.",
          bill && bill.duplicateCustomers > 0 ? `:warning: ${bill.duplicateCustomers + 1} Stripe customers share this email.` : "",
        ]
          .filter(Boolean)
          .join("\n");
        const m = await providers.slack!.postMessage(input.onboardingChannel, text);
        return { ref: m.ts, detail: { channel: m.channel } };
      },
    });

    if (bill && !bill.existingSubscriptionId) {
      actions.push({
        id: "stripe.create_subscription",
        kind: "stripe.create_subscription",
        provider: "stripe",
        agent: "billing-check",
        gate: "approval",
        summary: { priceId: bill.price.id, quantity: input.plan.quantity, amountPerPeriod: money(bill.price.unitAmountMinor * input.plan.quantity, bill.price.currency), interval: bill.price.interval },
        async execute({ providers, applied }) {
          const customerId = applied["stripe.ensure_customer"]?.ref;
          if (!customerId) throw new FatalError("no Stripe customer: stripe.ensure_customer did not apply");
          // The approval may come a day later; never double-subscribe.
          const live = (await providers.stripe!.listSubscriptions(customerId)).find(
            (s) => s.customer === customerId && EXISTING_SUB_STATES.has(s.status) && s.items.data.some((it) => it.price?.id === bill.price.id),
          );
          if (live) return { ref: live.id, detail: { created: false } };
          const sub = await providers.stripe!.createSubscription(customerId, bill.price.id, input.plan.quantity, { deal_id: input.dealId });
          return { ref: sub.id, detail: { created: true, status: sub.status } };
        },
        async reconcile({ providers }, receipt) {
          const s = await providers.stripe!.getSubscription(receipt.ref);
          const item = s.items?.data?.find((it) => it.price?.id === bill.price.id);
          if (!item) return { status: "drift", detail: "price no longer on the subscription" };
          if ((item.quantity ?? 1) !== input.plan.quantity) return { status: "drift", detail: `quantity ${item.quantity}, expected ${input.plan.quantity}` };
          return s.status === "canceled" ? { status: "missing", detail: "subscription canceled" } : { status: "match" };
        },
      });
    }

    if (slot) {
      actions.push({
        id: "calendar.kickoff_invite",
        kind: "calendar.kickoff_invite",
        provider: "calendar",
        agent: "kickoff-scheduler",
        gate: "approval",
        summary: { attendee: input.contact.email, start: slot.start, end: slot.end, sendsInvite: true },
        async execute({ providers, runId }) {
          const ev = await providers.calendar!.insertEvent(
            input.csmCalendarId,
            { summary: `ACME kickoff — ${input.company}`, description: `Onboarding kickoff for deal ${input.dealId}.`, start: slot.start, end: slot.end, attendees: [input.contact.email], privateKey: `${runId}:kickoff` },
            "all",
          );
          return { ref: ev.id, detail: { start: slot.start } };
        },
      });
    }
    return actions;
  },

  output({ input }, results) {
    const bill = out<BillingState>(results, "billing-check");
    const welcome = out<Welcome>(results, "welcome-composer");
    return {
      dealId: input.dealId,
      company: input.company,
      priceValid: !!bill,
      alreadySubscribed: !!bill?.existingSubscriptionId,
      duplicateStripeCustomers: bill?.duplicateCustomers ?? 0,
      amountPerPeriodMinor: welcome?.mrrMinor ?? 0,
      kickoff: out<Kickoff>(results, "kickoff-scheduler")?.slot?.start ?? null,
      welcomeDraftedBy: welcome?.draftedBy ?? "none",
    };
  },

  catalog: [
    { kind: "hubspot.upsert_customer", provider: "hubspot", gate: "auto", description: "Create/update the buyer's HubSpot contact as lifecyclestage=customer" },
    { kind: "stripe.ensure_customer", provider: "stripe", gate: "auto", description: "Find or create the Stripe customer (no charge)" },
    { kind: "zendesk.provision_requester", provider: "zendesk", gate: "auto", description: "Create/update the Zendesk organization and requester" },
    { kind: "gmail.draft_welcome", provider: "gmail", gate: "auto", description: "Create (not send) the welcome email draft" },
    { kind: "slack.post_handoff", provider: "slack", gate: "auto", description: "Post the Sales→CS handoff to the onboarding channel" },
    { kind: "stripe.create_subscription", provider: "stripe", gate: "approval", description: "Start the subscription (bills the customer)" },
    { kind: "calendar.kickoff_invite", provider: "calendar", gate: "approval", description: "Invite the buyer to the kickoff (sends an invitation)" },
  ],
};
