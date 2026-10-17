import { createHash } from "node:crypto";
import { z } from "zod";
import type { Deps } from "../deps";
import { FatalError } from "../lib/errors";
import { once } from "../lib/idempotency";
import { withLease } from "../lib/lease";
import { untrusted } from "../lib/llm";
import type { AgentResult, IntakeState, QuoteResult } from "../types";

const PlanSchema = z.object({
  lines: z.array(z.object({ priceId: z.string(), quantity: z.number().int().positive() })),
  unmatched: z.array(z.string()).describe("Requested items with no matching catalog price"),
});

const SYSTEM = `You map a customer's requested items onto a Stripe price catalog.
Only use priceIds that appear in the catalog. If an item has no clear match, list it under "unmatched" instead of guessing.
Do not apply discounts and do not compute totals.`;

/** Stripe customer for an email, created at most once even when many runs race. */
export function ensureStripeCustomer(d: Deps, email: string, name: string) {
  return withLease(d.store, `stripe-customer#${email}`, async () => {
    // customers.list is strongly consistent; customers.search lags by up to a
    // minute and would let a second run miss a customer created moments ago.
    const existing = await d.billing.findCustomer(email);
    if (existing) return existing;
    const key = `customer:${createHash("sha256").update(email).digest("hex")}`;
    return d.billing.createCustomer(email, name, key);
  });
}

export async function runQuote(s: IntakeState, d: Deps): Promise<AgentResult<QuoteResult>> {
  const req = s.intake.tasks.quote;
  const catalog = await d.billing.listCatalog();
  const plan = await d.llm.structured({
    task: "quote-map",
    schema: PlanSchema,
    effort: "low",
    system: SYSTEM,
    prompt: `Catalog:\n${JSON.stringify(catalog.map(({ priceId, product, lookupKey, unitAmount, currency, interval }) => ({ priceId, product, lookupKey, unitAmount, currency, interval })))}\n\n${untrusted("requested_items", JSON.stringify(req.items))}`,
  });

  // Never trust model arithmetic or ids: validate against the catalog and price in code.
  const byId = new Map(catalog.map((p) => [p.priceId, p]));
  const merged = new Map<string, number>();
  for (const l of plan.lines) if (byId.has(l.priceId)) merged.set(l.priceId, (merged.get(l.priceId) ?? 0) + l.quantity);
  if (!merged.size) throw new FatalError(`None of the requested items matched the Stripe catalog: ${req.items.map((i) => i.description).join(", ")}`);

  const lines = [...merged].map(([priceId, quantity]) => {
    const p = byId.get(priceId)!;
    return { priceId, product: p.product, quantity, unitAmount: p.unitAmount, subtotal: p.unitAmount * quantity };
  });
  const currencies = new Set(lines.map((l) => byId.get(l.priceId)!.currency));
  if (currencies.size > 1) throw new FatalError(`Quote mixes currencies (${[...currencies].join(", ")}); split the request.`);

  const discountPct = Math.min(100, Math.max(0, Math.round(req.requestedDiscountPct)));
  const gross = lines.reduce((n, l) => n + l.subtotal, 0);
  const totalCents = Math.round(gross * (1 - discountPct / 100));

  const { email, name, company } = s.intake.customer;
  const stripeCustomerId = await ensureStripeCustomer(d, email, name);

  // Draft only: nothing is customer-visible until a human approves and dispatch finalizes it.
  const stripeQuoteId = await once(d.store, `${s.runId}:stripe-quote`, () =>
    d.billing.createDraftQuote({ customerId: stripeCustomerId, lines, discountPct, idempotencyKey: `${s.runId}:quote` }),
  );
  const hubspotDealId = await once(d.store, `${s.runId}:hubspot-deal`, () =>
    d.crm.createDeal(s.crm.contactId, { name: `${company || email} — quote ${stripeQuoteId}`, amountCents: totalCents, stage: d.config.dealStage.quoted }),
  );

  return {
    agent: "quote",
    status: "ok",
    data: {
      stripeCustomerId,
      stripeQuoteId,
      hubspotDealId,
      currency: [...currencies][0]!,
      lines,
      discountPct,
      totalCents,
      unmatched: plan.unmatched,
      needsDiscountApproval: discountPct > d.config.maxAutoDiscountPct,
    },
  };
}
