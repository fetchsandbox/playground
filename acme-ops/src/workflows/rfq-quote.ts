import { z } from "zod";
import { FatalError } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { Approvers, ChannelId, Email, messageId, money, out, plain } from "./shared";

// Sales · sales-ops.
// Trigger: an RFQ from an OEM or distributor (email, portal or Slack).

/** Discount policy (percent off list), decided in code, never by the model. */
export const AUTO_DISCOUNT_MAX = 10;
export const APPROVAL_DISCOUNT_MAX = 30;

const Input = z.object({
  buyer: z.object({ email: Email, firstname: z.string().min(1).max(100), lastname: z.string().max(100).optional() }),
  company: z.string().min(1).max(200),
  lines: z
    .array(z.object({ product: z.string().min(1).max(200), quantity: z.number().int().min(1).max(100_000) }))
    .min(1)
    .max(20),
  requestedDiscountPct: z.number().min(0).max(100).default(0),
  salesChannel: ChannelId,
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

interface PricedLine {
  request: string;
  productId: string;
  productName: string;
  priceId: string;
  unitMinor: number;
  quantity: number;
  interval: string | null;
}
interface Catalog {
  lines: PricedLine[];
  unknown: string[];
  currency: string;
}
interface Crm {
  contactId?: string;
  lifecycle?: string;
}
export type Policy = "auto" | "approval" | "declined";
interface Quote {
  subtotalMinor: number;
  discountPct: number;
  policy: Policy;
  totalMinor: number;
  cover: { subject: string; body: string; draftedBy: string };
}

export function discountPolicy(requested: number): { policy: Policy; applied: number } {
  if (requested <= AUTO_DISCOUNT_MAX) return { policy: "auto", applied: requested };
  if (requested <= APPROVAL_DISCOUNT_MAX) return { policy: "approval", applied: requested };
  return { policy: "declined", applied: 0 };
}

const PRE_CUSTOMER = new Set(["", "subscriber", "lead", "marketingqualifiedlead", "salesqualifiedlead"]);

export const rfqQuote: WorkflowDef<Input> = {
  id: "rfq-quote",
  title: "RFQ to quote",
  org: "Sales",
  team: "sales-ops",
  description:
    "Turn an RFQ into a priced Stripe quote: match parts to the catalog, price in code, apply the discount policy (≤10% automatic, ≤30% needs approval, above that declined), update HubSpot and post to Slack. Finalizing a quote with an approval-level discount waits for approval.",
  input: Input,
  agents: [
    {
      name: "catalog-pricing",
      needs: ["stripe"],
      async run({ input, providers }) {
        const stripe = providers.stripe!;
        const [products, prices] = await Promise.all([stripe.listProducts(), stripe.listPrices()]);
        const lines: PricedLine[] = [];
        const unknown: string[] = [];
        for (const l of input.lines) {
          const key = l.product.trim().toLowerCase();
          const p = products.find((x) => x.active && (x.id.toLowerCase() === key || x.name.toLowerCase() === key));
          const price = p && prices.filter((x) => x.product === p.id && x.active && x.unit_amount != null).sort((a, b) => a.id.localeCompare(b.id))[0];
          if (!p || !price) {
            unknown.push(l.product);
            continue;
          }
          lines.push({ request: l.product, productId: p.id, productName: p.name, priceId: price.id, unitMinor: price.unit_amount!, quantity: l.quantity, interval: price.recurring?.interval ?? null });
        }
        const currencies = new Set(lines.map((l) => prices.find((p) => p.id === l.priceId)?.currency ?? "usd"));
        if (currencies.size > 1) throw new FatalError("RFQ mixes currencies; quote manually");
        const data: Catalog = { lines, unknown, currency: [...currencies][0] ?? "usd" };
        return { summary: `${lines.length} line(s) priced${unknown.length ? `, unknown: ${unknown.join(", ")}` : ""}`, data };
      },
    },
    {
      name: "customer-lookup",
      needs: ["stripe"],
      async run({ input, providers }) {
        const c = await providers.stripe!.findCustomerByEmail(input.buyer.email);
        return { summary: c ? `Stripe customer ${c.id}` : "new Stripe customer", data: { customerId: c?.id ?? null } };
      },
    },
    {
      name: "crm-lookup",
      needs: ["hubspot"],
      async run({ input, providers }) {
        const c = await providers.hubspot!.findByEmail(input.buyer.email);
        const data: Crm = { contactId: c?.id, lifecycle: c?.properties.lifecyclestage ?? undefined };
        return { summary: c ? `contact ${c.id} (${data.lifecycle ?? "no stage"})` : "new contact", data };
      },
    },
  ],

  compose: {
    name: "quote-composer",
    async run({ input, drafter }, results) {
      const cat = out<Catalog>(results, "catalog-pricing");
      const subtotalMinor = (cat?.lines ?? []).reduce((n, l) => n + l.unitMinor * l.quantity, 0);
      const { policy, applied } = discountPolicy(input.requestedDiscountPct);
      const totalMinor = Math.round(subtotalMinor * (1 - applied / 100));
      const currency = cat?.currency ?? "usd";
      const lineText = (cat?.lines ?? []).map((l) => `${l.quantity} × ${l.productName} at ${money(l.unitMinor, currency)}${l.interval ? `/${l.interval}` : ""}`).join("\n");
      const cover = await drafter.draft({
        task: "quote-cover",
        instructions: "Draft a short cover email for a quote. List the lines and total given. If the discount was declined, say the quote is at list price and offer a call. Do not invent terms.",
        facts: { firstName: input.buyer.firstname, company: input.company, lines: lineText, discountPct: applied, total: money(totalMinor, currency), discountDeclined: policy === "declined" },
        fallback: {
          subject: `ACME quote for ${plain(input.company, 80)}`,
          body: `Hi ${input.buyer.firstname},\n\nThanks for your request. Here is your quote:\n\n${lineText}\n${applied ? `Discount: ${applied}%\n` : ""}Total: ${money(totalMinor, currency)}\n${policy === "declined" ? `\nWe can't offer the ${input.requestedDiscountPct}% discount requested, so this quote is at list price; happy to discuss volume pricing on a call.\n` : ""}\nThe ACME sales team`,
        },
      });
      const data: Quote = { subtotalMinor, discountPct: applied, policy, totalMinor, cover };
      return { summary: `${money(totalMinor, currency)} at ${applied}% (${policy})`, data };
    },
  },

  plan({ input }, results) {
    const cat = out<Catalog>(results, "catalog-pricing");
    const crm = out<Crm>(results, "crm-lookup");
    const known = out<{ customerId: string | null }>(results, "customer-lookup");
    const q = out<Quote>(results, "quote-composer");
    if (!q) return [];
    const currency = cat?.currency ?? "usd";
    // One Stripe quote carries one recurring interval; mixed terms are quoted by a person.
    const intervals = new Set((cat?.lines ?? []).map((l) => l.interval ?? "one_time"));
    const blocker = !cat ? "catalog unavailable" : cat.unknown.length ? `unknown part(s) ${cat.unknown.map((u) => plain(u, 60)).join(", ")}` : !cat.lines.length ? "no lines" : intervals.size > 1 ? `mixed billing terms (${[...intervals].join(" + ")}); split into separate quotes` : !known ? "Stripe customer lookup failed" : null;
    const quotable = blocker === null;
    const actions: PlannedAction<Input>[] = [];

    if (crm) {
      actions.push({
        id: "hubspot.upsert_buyer",
        kind: "hubspot.upsert_buyer",
        provider: "hubspot",
        agent: "crm-lookup",
        gate: "auto",
        summary: { email: input.buyer.email, company: input.company, stage: PRE_CUSTOMER.has(crm.lifecycle ?? "") ? "opportunity" : "unchanged" },
        async execute({ providers }) {
          const props: Record<string, string> = { firstname: input.buyer.firstname, company: input.company };
          if (input.buyer.lastname) props.lastname = input.buyer.lastname;
          // Never downgrade an existing customer.
          if (PRE_CUSTOMER.has(crm.lifecycle ?? "")) props.lifecyclestage = "opportunity";
          const { contact, created } = await providers.hubspot!.upsertByEmail(input.buyer.email, props);
          return { ref: contact.id, detail: { created } };
        },
      });
    }

    if (quotable) {
      actions.push({
        id: "stripe.ensure_customer",
        kind: "stripe.ensure_customer",
        provider: "stripe",
        agent: "customer-lookup",
        gate: "auto",
        summary: { email: input.buyer.email, existing: known!.customerId },
        async execute({ providers, runId }) {
          if (known!.customerId) return { ref: known!.customerId, detail: { created: false } };
          const again = await providers.stripe!.findCustomerByEmail(input.buyer.email);
          if (again) return { ref: again.id, detail: { created: false } };
          const name = [input.buyer.firstname, input.buyer.lastname].filter(Boolean).join(" ");
          const c = await providers.stripe!.createCustomer(input.buyer.email, name, { company: input.company }, `rfq-${runId}-customer`);
          return { ref: c.id, detail: { created: true } };
        },
      });
      actions.push({
        id: "stripe.draft_quote",
        kind: "stripe.draft_quote",
        provider: "stripe",
        agent: "quote-composer",
        gate: "auto",
        summary: { lines: cat!.lines.length, subtotal: money(q.subtotalMinor, currency), discountPct: q.discountPct, total: money(q.totalMinor, currency), policy: q.policy },
        async execute({ providers, applied, runId }) {
          const customer = applied["stripe.ensure_customer"]?.ref;
          if (!customer) throw new FatalError("no Stripe customer: stripe.ensure_customer did not apply");
          // The discount is recorded on the quote; ACME applies it as a coupon at invoicing.
          const quote = await providers.stripe!.createQuote(
            customer,
            cat!.lines.map((l) => ({ price: l.priceId, quantity: l.quantity })),
            { rfq_run: runId, discount_pct: String(q.discountPct), discount_policy: q.policy, quoted_total_minor: String(q.totalMinor) },
            `rfq-${runId}-quote`,
          );
          return { ref: quote.id, detail: { status: quote.status } };
        },
      });
      actions.push({
        id: "stripe.finalize_quote",
        kind: "stripe.finalize_quote",
        provider: "stripe",
        agent: "quote-composer",
        // Only an approval-level discount needs a person; list price and small discounts go out.
        gate: q.policy === "approval" ? "approval" : "auto",
        summary: { discountPct: q.discountPct, requestedDiscountPct: input.requestedDiscountPct, total: money(q.totalMinor, currency), policy: q.policy },
        async execute({ providers, applied }) {
          const id = applied["stripe.draft_quote"]?.ref;
          if (!id) throw new FatalError("no quote: stripe.draft_quote did not apply");
          const cur = await providers.stripe!.getQuote(id);
          if (cur.status !== "draft") return { ref: id, detail: { status: cur.status, finalized: false } };
          const f = await providers.stripe!.finalizeQuote(id);
          return { ref: id, detail: { status: f.status } };
        },
        async reconcile({ providers }, receipt) {
          const cur = await providers.stripe!.getQuote(receipt.ref);
          if (cur.status === "canceled") return { status: "missing", detail: "quote canceled" };
          return cur.status === "draft" ? { status: "drift", detail: "quote is back in draft" } : { status: "match" };
        },
      });
      actions.push({
        id: "gmail.draft_quote_cover",
        kind: "gmail.draft_quote_cover",
        provider: "gmail",
        agent: "quote-composer",
        gate: q.policy === "approval" ? "approval" : "auto",
        summary: { to: input.buyer.email, subject: q.cover.subject, draftedBy: q.cover.draftedBy, sent: false },
        async execute({ providers, runId, applied }) {
          // A cover email never goes out without the quote it covers.
          if (!applied["stripe.finalize_quote"]) throw new FatalError("quote not finalized: no cover email");
          const d = await providers.gmail!.createDraft({ to: input.buyer.email, subject: q.cover.subject, body: q.cover.body, messageId: messageId(runId, "quote") });
          return { ref: d.id };
        },
      });
    }

    actions.push({
      id: "slack.post_rfq",
      kind: "slack.post_rfq",
      provider: "slack",
      agent: "quote-composer",
      gate: "auto",
      summary: { channel: input.salesChannel, quotable, policy: q.policy },
      async execute({ providers }) {
        const text = quotable
          ? `:memo: RFQ from ${plain(input.company, 80)} (${input.buyer.email}): ${money(q.totalMinor, currency)} at ${q.discountPct}% off. ${q.policy === "approval" ? `${input.requestedDiscountPct}% discount needs approval before the quote goes out.` : q.policy === "declined" ? `Requested ${input.requestedDiscountPct}% declined; quoted at list.` : "Quote finalized."}`
          : `:warning: RFQ from ${plain(input.company, 80)} (${input.buyer.email}) needs manual pricing: ${blocker}.`;
        const m = await providers.slack!.postMessage(input.salesChannel, text);
        return { ref: m.ts, detail: { channel: m.channel } };
      },
    });
    return actions;
  },

  output({ input }, results) {
    const cat = out<Catalog>(results, "catalog-pricing");
    const q = out<Quote>(results, "quote-composer");
    return {
      company: input.company,
      pricedLines: cat?.lines.length ?? 0,
      quotable: !!cat && cat.unknown.length === 0 && cat.lines.length > 0 && new Set(cat.lines.map((l) => l.interval ?? "one_time")).size === 1,
      unknownParts: cat?.unknown ?? [],
      subtotalMinor: q?.subtotalMinor ?? 0,
      discountPct: q?.discountPct ?? 0,
      totalMinor: q?.totalMinor ?? 0,
      policy: q?.policy ?? "unknown",
    };
  },

  catalog: [
    { kind: "hubspot.upsert_buyer", provider: "hubspot", gate: "auto", description: "Create/update the buyer contact (opportunity unless already further along)" },
    { kind: "stripe.ensure_customer", provider: "stripe", gate: "auto", description: "Find or create the Stripe customer (no charge)" },
    { kind: "stripe.draft_quote", provider: "stripe", gate: "auto", description: "Create the draft Stripe quote at catalog prices" },
    { kind: "stripe.finalize_quote", provider: "stripe", gate: "approval", description: "Finalize the quote (automatic at ≤10% discount, approval above)" },
    { kind: "gmail.draft_quote_cover", provider: "gmail", gate: "approval", description: "Create (not send) the cover email (with the finalize gate)" },
    { kind: "slack.post_rfq", provider: "slack", gate: "auto", description: "Post the RFQ outcome or the manual-pricing request to Sales" },
  ],
};
