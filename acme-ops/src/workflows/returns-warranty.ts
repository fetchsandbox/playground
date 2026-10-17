import { z } from "zod";
import { FatalError } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { stripeTime } from "../providers/stripe";
import { Approvers, ChannelId, Email, messageId, money, out, plain, shortHash } from "./shared";

// Customer Experience · cx-service.
// Trigger: a customer reports a failed unit (email, portal or Zendesk ticket).

/** ACME sensors carry a 24-month warranty from the invoice date. */
export const WARRANTY_MONTHS = 24;

const Input = z.object({
  customer: z.object({ email: Email, name: z.string().max(200).optional() }),
  invoiceId: z.string().regex(/^in_\w+$/, "Stripe invoice id like in_123"),
  partNumber: z.string().min(1).max(100),
  serial: z.string().max(100).optional(),
  failure: z.string().min(1).max(4000),
  /** The customer asks for a credit (rather than repair or replacement only). */
  creditRequested: z.boolean().default(true),
  /** Credit for this unit; defaults to the invoice amount paid, never more. */
  creditAmountMinor: z.number().int().positive().optional(),
  returnsChannel: ChannelId,
  /** Asana workspace (or project) of the returns dock. */
  returnsWorkspace: z.string().min(1).default("acme-returns"),
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

interface Order {
  customerId: string;
  invoiceId: string;
  number: string;
  invoicedAt: string;
  warrantyEndsAt: string;
  inWarranty: boolean;
  paid: boolean;
  amountPaidMinor: number;
  currency: string;
}
interface Account {
  found: boolean;
  company?: string;
  lifecycle?: string;
}
interface Rma {
  rmaNumber: string;
  creditEligible: boolean;
  creditMinor: number;
  reason: string;
  reply: { subject: string; body: string; draftedBy: string };
}

export function warrantyEnd(invoicedAtMs: number): Date {
  const d = new Date(invoicedAtMs);
  d.setUTCMonth(d.getUTCMonth() + WARRANTY_MONTHS);
  return d;
}

export const returnsWarranty: WorkflowDef<Input> = {
  id: "returns-warranty",
  title: "Returns and warranty (RMA)",
  org: "Customer Experience",
  team: "cx-service",
  description:
    "Verify the purchase and warranty of a failed unit against the Stripe invoice, open the RMA for the returns dock, draft return instructions and post to Slack. A warranty credit note waits for approval and is never offered out of warranty or on an unpaid invoice.",
  input: Input,
  agents: [
    {
      name: "order-lookup",
      needs: ["stripe"],
      async run({ input, providers, startedAt }) {
        const stripe = providers.stripe!;
        const customer = await stripe.findCustomerByEmail(input.customer.email);
        if (!customer) throw new FatalError(`no Stripe customer for ${input.customer.email}`);
        const inv = await stripe.getInvoice(input.invoiceId);
        // An RMA is only issued against the claimant's own purchase.
        if (inv.customer !== customer.id) throw new FatalError(`invoice ${input.invoiceId} does not belong to ${input.customer.email}`);
        const invoicedAt = stripeTime(inv.created) ?? startedAt.getTime();
        const ends = warrantyEnd(invoicedAt);
        const data: Order = {
          customerId: customer.id,
          invoiceId: inv.id,
          number: inv.number ?? inv.id,
          invoicedAt: new Date(invoicedAt).toISOString(),
          warrantyEndsAt: ends.toISOString(),
          inWarranty: startedAt.getTime() <= ends.getTime(),
          paid: inv.status === "paid",
          amountPaidMinor: (inv as { amount_paid?: number }).amount_paid ?? 0,
          currency: inv.currency ?? "usd",
        };
        return { summary: `${data.number}: ${data.inWarranty ? "in" : "out of"} warranty until ${data.warrantyEndsAt.slice(0, 10)}, ${data.paid ? "paid" : inv.status}`, data };
      },
    },
    {
      name: "account-context",
      needs: ["hubspot"],
      async run({ input, providers }) {
        const c = await providers.hubspot!.findByEmail(input.customer.email);
        const data: Account = c ? { found: true, company: c.properties.company ?? undefined, lifecycle: c.properties.lifecyclestage ?? undefined } : { found: false };
        return { summary: c ? `HubSpot contact ${c.id}` : "not in HubSpot", data };
      },
    },
    {
      name: "ticket-history",
      needs: ["zendesk"],
      async run({ input, providers }) {
        const tickets = await providers.zendesk!.searchTickets(`requester:${input.customer.email}`, 50);
        return { summary: `${tickets.length} Zendesk ticket(s)`, data: { tickets: tickets.length } };
      },
    },
  ],

  compose: {
    name: "rma-composer",
    async run({ input, runId, drafter }, results) {
      const order = out<Order>(results, "order-lookup");
      const rmaNumber = `RMA-${shortHash(runId).slice(0, 8).toUpperCase()}`;
      const creditMinor = order ? Math.min(input.creditAmountMinor ?? order.amountPaidMinor, order.amountPaidMinor) : 0;
      let reason: string;
      if (!order) reason = "purchase not verified";
      else if (!input.creditRequested) reason = "no credit requested";
      else if (!order.inWarranty) reason = `out of warranty since ${order.warrantyEndsAt.slice(0, 10)}`;
      else if (!order.paid) reason = "invoice not paid; credit handled by AR";
      else if (creditMinor <= 0) reason = "nothing paid to credit";
      else reason = "in warranty and paid";
      const creditEligible = reason === "in warranty and paid";
      const first = input.customer.name?.split(" ")[0] ?? "there";
      const reply = await drafter.draft({
        task: "rma-instructions",
        instructions: "Draft return instructions for a failed unit. Give the RMA number, ask them to include it on the package, and say whether a warranty credit is being reviewed. Do not promise a credit or a ship date.",
        facts: { firstName: first, rmaNumber, partNumber: input.partNumber, serial: input.serial ?? null, warrantyStatus: order ? (order.inWarranty ? "in warranty" : "out of warranty") : "unverified", creditUnderReview: creditEligible },
        fallback: {
          subject: `${rmaNumber}: return for ${plain(input.partNumber, 80)}`,
          body: `Hi ${first},\n\nWe've opened ${rmaNumber} for your ${plain(input.partNumber, 80)}${input.serial ? ` (serial ${plain(input.serial, 60)})` : ""}.\n\nPlease write ${rmaNumber} on the outside of the package and ship it to ACME Returns, 100 Sensor Way, Austin TX 78701.\n${creditEligible ? "The unit is under warranty, and a credit is being reviewed.\n" : order && !order.inWarranty ? "This unit is outside its warranty period; we'll send a repair estimate after inspection.\n" : ""}\nACME Customer Experience`,
        },
      });
      const data: Rma = { rmaNumber, creditEligible, creditMinor, reason, reply };
      return { summary: `${rmaNumber}; credit ${creditEligible ? money(creditMinor, order?.currency) : "no"} (${reason})`, data };
    },
  },

  plan({ input }, results) {
    const order = out<Order>(results, "order-lookup");
    const rma = out<Rma>(results, "rma-composer");
    if (!rma) return [];
    const actions: PlannedAction<Input>[] = [];
    if (order) {
      actions.push({
        id: "asana.create_rma",
        kind: "asana.create_rma",
        provider: "asana",
        agent: "rma-composer",
        gate: "auto",
        summary: { rmaNumber: rma.rmaNumber, invoice: order.number, partNumber: input.partNumber, inWarranty: order.inWarranty },
        async execute({ providers }) {
          const t = await providers.asana!.createTask({
            name: `${rma.rmaNumber}: ${plain(input.partNumber, 80)} from ${input.customer.email}`,
            notes: `Invoice ${order.number} (${order.invoiceId}). Serial: ${input.serial ?? "n/a"}.\nWarranty: ${order.inWarranty ? "in" : "out"} (until ${order.warrantyEndsAt.slice(0, 10)}).\nReported failure: ${plain(input.failure, 1500)}`,
            workspace: input.returnsWorkspace,
          });
          return { ref: t.gid };
        },
        async reconcile({ providers }, receipt) {
          const t = await providers.asana!.getTask(receipt.ref);
          return t.name?.startsWith(rma.rmaNumber) ? { status: "match" } : { status: "drift", detail: `task is now "${t.name}"` };
        },
      });
      actions.push({
        id: "gmail.draft_rma_instructions",
        kind: "gmail.draft_rma_instructions",
        provider: "gmail",
        agent: "rma-composer",
        gate: "auto",
        summary: { to: input.customer.email, subject: rma.reply.subject, draftedBy: rma.reply.draftedBy, sent: false },
        async execute({ providers, runId }) {
          const d = await providers.gmail!.createDraft({ to: input.customer.email, subject: rma.reply.subject, body: rma.reply.body, messageId: messageId(runId, "rma") });
          return { ref: d.id };
        },
      });
    }
    actions.push({
      id: "slack.post_rma",
      kind: "slack.post_rma",
      provider: "slack",
      agent: "rma-composer",
      gate: "auto",
      summary: { channel: input.returnsChannel, rmaNumber: rma.rmaNumber, creditEligible: rma.creditEligible },
      async execute({ providers }) {
        const text = order
          ? `:package: ${rma.rmaNumber} opened for ${input.customer.email}: ${plain(input.partNumber, 80)} on ${order.number}. Warranty ${order.inWarranty ? "valid" : "expired"}; credit: ${rma.creditEligible ? `${money(rma.creditMinor, order.currency)} awaiting approval` : rma.reason}.`
          : `:warning: Return request from ${input.customer.email} for ${plain(input.partNumber, 80)} could not be matched to invoice ${input.invoiceId}; no RMA issued, needs manual verification.`;
        const m = await providers.slack!.postMessage(input.returnsChannel, text);
        return { ref: m.ts, detail: { channel: m.channel } };
      },
    });
    if (order && rma.creditEligible) {
      actions.push({
        id: "stripe.warranty_credit_note",
        kind: "stripe.warranty_credit_note",
        provider: "stripe",
        agent: "rma-composer",
        gate: "approval",
        summary: { invoice: order.number, amount: money(rma.creditMinor, order.currency), rmaNumber: rma.rmaNumber, reason: "product_unsatisfactory" },
        async execute({ providers }) {
          const http = providers.stripe!.http;
          // Never credit the same RMA twice, even from another run.
          const { body: existing } = await http.request<any>("GET", "/v1/credit_notes", { query: { invoice: order.invoiceId, limit: 100 } });
          const prior = (existing?.data ?? []).find((c: any) => c?.metadata?.rma === rma.rmaNumber);
          if (prior) return { ref: prior.id, detail: { created: false } };
          const { body } = await http.request<any>("POST", "/v1/credit_notes", {
            form: { invoice: order.invoiceId, credit_amount: rma.creditMinor, reason: "product_unsatisfactory", memo: `${rma.rmaNumber} warranty credit`, "metadata[rma]": rma.rmaNumber },
          });
          return { ref: body.id, detail: { created: true, amountMinor: rma.creditMinor } };
        },
        async reconcile({ providers }, receipt) {
          const { body } = await providers.stripe!.http.request<any>("GET", `/v1/credit_notes/${encodeURIComponent(receipt.ref)}`);
          if (body?.status === "void") return { status: "missing", detail: "credit note voided" };
          return body?.amount === rma.creditMinor ? { status: "match" } : { status: "drift", detail: `credit note amount ${body?.amount}, expected ${rma.creditMinor}` };
        },
      });
    }
    return actions;
  },

  output({ input }, results) {
    const order = out<Order>(results, "order-lookup");
    const rma = out<Rma>(results, "rma-composer");
    return {
      rmaNumber: order ? (rma?.rmaNumber ?? null) : null,
      purchaseVerified: !!order,
      invoice: order?.number ?? input.invoiceId,
      inWarranty: order?.inWarranty ?? null,
      warrantyEndsAt: order?.warrantyEndsAt ?? null,
      creditEligible: rma?.creditEligible ?? false,
      creditMinor: rma?.creditEligible ? rma.creditMinor : 0,
      creditDecision: rma?.reason ?? "not decided",
    };
  },

  catalog: [
    { kind: "asana.create_rma", provider: "asana", gate: "auto", description: "Open the RMA task for the returns dock (verified purchases only)" },
    { kind: "gmail.draft_rma_instructions", provider: "gmail", gate: "auto", description: "Create (not send) the return-instructions draft" },
    { kind: "slack.post_rma", provider: "slack", gate: "auto", description: "Post the RMA (or the failed verification) to the returns channel" },
    { kind: "stripe.warranty_credit_note", provider: "stripe", gate: "approval", description: "Issue a warranty credit note on the paid invoice (in warranty only)" },
  ],
};
