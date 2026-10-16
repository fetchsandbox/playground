import Stripe from "stripe";
import { FatalError, RetryableError } from "../lib/errors";

export interface CatalogPrice {
  priceId: string;
  lookupKey: string | null;
  product: string;
  unitAmount: number;
  currency: string;
  interval: string | null;
}

export interface BillingSnapshot {
  invoices: { id: string; status: string; amountDue: number; amountRemaining: number; dueDate: number | null; currency: string }[];
  subscriptions: { id: string; status: string; items: string[] }[];
}

export interface Billing {
  /** Strongly consistent lookup (customers.list by email, not the lagging search API). */
  findCustomer(email: string): Promise<string | null>;
  createCustomer(email: string, name: string, idempotencyKey: string): Promise<string>;
  listCatalog(): Promise<CatalogPrice[]>;
  snapshot(customerId: string): Promise<BillingSnapshot>;
  createDraftQuote(args: {
    customerId: string;
    lines: { priceId: string; quantity: number }[];
    discountPct: number;
    idempotencyKey: string;
  }): Promise<string>;
  finalizeQuote(quoteId: string, idempotencyKey: string): Promise<{ number: string | null; status: string }>;
}

/** Translate Stripe SDK errors into the workflow taxonomy. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Stripe.errors.StripeRateLimitError) throw new RetryableError(err.message, 2_000);
    if (err instanceof Stripe.errors.StripeConnectionError || err instanceof Stripe.errors.StripeAPIError) {
      throw new RetryableError(err.message);
    }
    // Stripe's lock_timeout / idempotency-key-in-use: concurrent request on same object or key.
    if (err instanceof Stripe.errors.StripeError && (err.code === "lock_timeout" || err.statusCode === 409)) {
      throw new RetryableError(err.message, 1_000);
    }
    if (err instanceof Stripe.errors.StripeError) throw new FatalError(`stripe: ${err.message}`);
    throw err;
  }
}

export class StripeBilling implements Billing {
  private readonly stripe: Stripe;
  constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 20_000 });
  }

  findCustomer(email: string) {
    return guard(async () => {
      const res = await this.stripe.customers.list({ email, limit: 1 });
      return res.data[0]?.id ?? null;
    });
  }

  createCustomer(email: string, name: string, idempotencyKey: string) {
    return guard(async () => {
      const c = await this.stripe.customers.create({ email, name: name || undefined }, { idempotencyKey });
      return c.id;
    });
  }

  listCatalog() {
    return guard(async () => {
      const res = await this.stripe.prices.list({ active: true, limit: 100, expand: ["data.product"] });
      return res.data
        .filter((p) => p.unit_amount != null)
        .map((p) => ({
          priceId: p.id,
          lookupKey: p.lookup_key,
          product: typeof p.product === "object" && "name" in p.product ? p.product.name : String(p.product),
          unitAmount: p.unit_amount ?? 0,
          currency: p.currency,
          interval: p.recurring?.interval ?? null,
        }));
    });
  }

  snapshot(customerId: string) {
    return guard(async () => {
      const [inv, subs] = await Promise.all([
        this.stripe.invoices.list({ customer: customerId, limit: 20 }),
        this.stripe.subscriptions.list({ customer: customerId, status: "all", limit: 20 }),
      ]);
      return {
        invoices: inv.data.map((i) => ({
          id: i.id ?? "",
          status: i.status ?? "unknown",
          amountDue: i.amount_due,
          amountRemaining: i.amount_remaining,
          dueDate: i.due_date ?? null,
          currency: i.currency,
        })),
        subscriptions: subs.data.map((s) => ({
          id: s.id,
          status: s.status,
          items: s.items.data.map((it) => it.price.lookup_key ?? it.price.id),
        })),
      };
    });
  }

  createDraftQuote(a: { customerId: string; lines: { priceId: string; quantity: number }[]; discountPct: number; idempotencyKey: string }) {
    return guard(async () => {
      let discounts: Stripe.QuoteCreateParams.Discount[] | undefined;
      if (a.discountPct > 0) {
        const coupon = await this.stripe.coupons.create(
          { percent_off: a.discountPct, duration: "once", name: `Quote discount ${a.discountPct}%` },
          { idempotencyKey: `${a.idempotencyKey}:coupon` },
        );
        discounts = [{ coupon: coupon.id }];
      }
      const q = await this.stripe.quotes.create(
        { customer: a.customerId, line_items: a.lines.map((l) => ({ price: l.priceId, quantity: l.quantity })), discounts },
        { idempotencyKey: a.idempotencyKey },
      );
      return q.id;
    });
  }

  finalizeQuote(quoteId: string, idempotencyKey: string) {
    return guard(async () => {
      const current = await this.stripe.quotes.retrieve(quoteId);
      if (current.status !== "draft") return { number: current.number, status: current.status };
      const q = await this.stripe.quotes.finalizeQuote(quoteId, {}, { idempotencyKey });
      return { number: q.number, status: q.status };
    });
  }
}
