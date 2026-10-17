import type { ProviderHttp } from "../kit/http";

export interface StripeCustomer {
  id: string;
  email: string | null;
  name?: string | null;
  metadata?: Record<string, string>;
}
export interface StripePrice {
  id: string;
  active: boolean;
  currency: string;
  unit_amount: number | null;
  recurring?: { interval: string } | null;
}
export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end?: boolean;
  items: { data: { price: StripePrice; quantity?: number }[] };
  metadata?: Record<string, string>;
}
export interface StripeInvoice {
  id: string;
  customer: string;
  status: string;
  amount_due: number;
  amount_remaining: number;
  currency: string;
}
export interface StripeRefund {
  id: string;
  amount: number;
  currency: string;
  charge: string | null;
  status: string;
  reason?: string | null;
}

interface List<T> {
  data: T[];
  has_more: boolean;
}

/** Stripe REST v1 (form-encoded writes, cursor pagination). */
export class StripeClient {
  constructor(private readonly http: ProviderHttp) {}

  /** Walks `starting_after` pages up to `max` items. */
  private async listAll<T extends { id: string }>(path: string, query: Record<string, string | number | undefined> = {}, max = 1000): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    while (out.length < max) {
      const { body } = await this.http.request<List<T>>("GET", path, { query: { limit: 100, ...query, starting_after: after } });
      const page = body?.data ?? [];
      out.push(...page);
      if (!body?.has_more || page.length === 0) break;
      after = page[page.length - 1]!.id;
    }
    return out.slice(0, max);
  }

  async findCustomerByEmail(email: string): Promise<StripeCustomer | undefined> {
    const matches = await this.listAll<StripeCustomer>("/v1/customers", { email }, 100);
    // Some backends ignore the filter; never trust a match we didn't check.
    const exact = matches.filter((c) => c.email?.toLowerCase() === email.toLowerCase());
    return exact.sort((a, b) => a.id.localeCompare(b.id))[0];
  }

  listCustomers(max?: number) {
    return this.listAll<StripeCustomer>("/v1/customers", {}, max);
  }

  async createCustomer(email: string, name: string | undefined, metadata: Record<string, string>, idempotencyKey: string): Promise<StripeCustomer> {
    const form: Record<string, string | undefined> = { email, name };
    for (const [k, v] of Object.entries(metadata)) form[`metadata[${k}]`] = v;
    const { body } = await this.http.request<StripeCustomer>("POST", "/v1/customers", { form, headers: { "Idempotency-Key": idempotencyKey } });
    return body;
  }

  async getCustomer(id: string): Promise<StripeCustomer> {
    return (await this.http.request<StripeCustomer>("GET", `/v1/customers/${encodeURIComponent(id)}`)).body;
  }

  async getPrice(id: string): Promise<StripePrice> {
    return (await this.http.request<StripePrice>("GET", `/v1/prices/${encodeURIComponent(id)}`)).body;
  }

  /** Every subscription that isn't canceled (Stripe's default when `status` is omitted). */
  listSubscriptions(customer?: string) {
    return this.listAll<StripeSubscription>("/v1/subscriptions", { customer });
  }

  listCanceledSubscriptions(customer: string) {
    return this.listAll<StripeSubscription>("/v1/subscriptions", { customer, status: "canceled" });
  }

  async getSubscription(id: string): Promise<StripeSubscription> {
    return (await this.http.request<StripeSubscription>("GET", `/v1/subscriptions/${encodeURIComponent(id)}`)).body;
  }

  async createSubscription(customer: string, priceId: string, quantity: number, metadata: Record<string, string>): Promise<StripeSubscription> {
    const form: Record<string, string | number> = { customer, "items[0][price]": priceId, "items[0][quantity]": quantity };
    for (const [k, v] of Object.entries(metadata)) form[`metadata[${k}]`] = v;
    return (await this.http.request<StripeSubscription>("POST", "/v1/subscriptions", { form })).body;
  }

  listInvoices(customer?: string, status?: string) {
    return this.listAll<StripeInvoice>("/v1/invoices", { customer, status });
  }

  listRefunds() {
    return this.listAll<StripeRefund>("/v1/refunds");
  }
}

/** Monthly recurring revenue of one subscription, in minor units. */
export function subscriptionMrr(sub: StripeSubscription): number {
  return sub.items.data.reduce((sum, it) => {
    const amount = it.price.unit_amount ?? 0;
    const qty = it.quantity ?? 1;
    const interval = it.price.recurring?.interval;
    const monthly = interval === "year" ? Math.round(amount / 12) : interval === "week" ? Math.round((amount * 52) / 12) : amount;
    return sum + monthly * qty;
  }, 0);
}

/** Subscription states that still represent a paying (or owing) customer. */
export const LIVE_SUB_STATES = new Set(["active", "trialing", "past_due", "unpaid"]);

/**
 * States in which a subscription already exists for duplicate-prevention
 * purposes. `incomplete` is what Stripe returns while the first payment is
 * pending (e.g. no payment method yet); creating another one would double-bill.
 */
export const EXISTING_SUB_STATES = new Set([...LIVE_SUB_STATES, "incomplete"]);
