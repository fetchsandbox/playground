import type { ProviderHttp } from "../kit/http";

export interface StripeCustomer {
  id: string;
  email: string | null;
  name?: string | null;
  metadata?: Record<string, string>;
  address?: Record<string, string | null> | null;
  created?: number;
}
export interface StripeConnectedAccount {
  id: string;
  country?: string | null;
  business_profile?: { name?: string | null } | null;
  company?: { name?: string | null } | null;
  individual?: { first_name?: string | null; last_name?: string | null } | null;
  settings?: { payouts?: { schedule?: { interval?: string } } } | null;
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
  // `price` is always present on real Stripe items; FetchSandbox seed items omit it.
  items: { data: { price?: StripePrice; quantity?: number }[] };
  metadata?: Record<string, string>;
  latest_invoice?: string | null;
  start_date?: number | string;
  created?: number | string;
  canceled_at?: number | string | null;
}
export interface StripeInvoice {
  id: string;
  customer: string;
  status: string;
  amount_due: number;
  amount_remaining: number;
  currency: string;
  /** Epoch seconds on real Stripe; some backends send ISO strings. */
  due_date?: number | string | null;
  created?: number | string;
  charge?: string | null;
  payment_intent?: string | null;
  amount_paid?: number;
  number?: string | null;
  lines?: { data: { price?: { id: string; product?: string } | null; quantity?: number; description?: string | null }[] };
  metadata?: Record<string, string>;
  subscription?: string | null;
  attempt_count?: number;
  next_payment_attempt?: number | null;
  default_payment_method?: string | null;
}
export interface StripeProduct {
  id: string;
  name: string;
  active: boolean;
  description?: string | null;
  default_price?: string | null;
  metadata?: Record<string, string>;
}
export interface StripeQuote {
  id: string;
  status: string;
  customer: string;
  amount_total?: number;
  currency?: string;
  metadata?: Record<string, string>;
}
export interface StripeRefund {
  id: string;
  amount: number;
  currency: string;
  charge: string | null;
  status: string;
  reason?: string | null;
  payment_intent?: string | null;
  metadata?: Record<string, string>;
}
export interface StripePaymentIntent {
  id: string;
  amount: number;
  amount_received?: number;
  currency: string;
  status: string;
  customer?: string | null;
  latest_charge?: string | null;
  created?: number | string;
  metadata?: Record<string, string>;
}

export interface StripeTransfer {
  id: string;
  amount: number;
  currency: string;
  destination: string | null;
  transfer_group?: string | null;
  reversed?: boolean;
  amount_reversed?: number;
  metadata?: Record<string, string>;
}

interface List<T> {
  data: T[];
  has_more: boolean;
}

/** Stripe REST v1 (form-encoded writes, cursor pagination). */
export class StripeClient {
  constructor(readonly http: ProviderHttp) {}

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
    return (await this.findCustomersByEmail(email)).sort((a, b) => a.id.localeCompare(b.id))[0];
  }

  async findCustomersByEmail(email: string): Promise<StripeCustomer[]> {
    const matches = await this.listAll<StripeCustomer>("/v1/customers", { email }, 100);
    return matches.filter((c) => c.email?.toLowerCase() === email.toLowerCase());
  }

  /** One page of customers, for callers that need to see the cursor's behaviour themselves. */
  async customerPage(limit: number, startingAfter?: string): Promise<{ data: StripeCustomer[]; has_more: boolean }> {
    const { body } = await this.http.request<{ data: StripeCustomer[]; has_more: boolean }>("GET", "/v1/customers", { query: { limit, starting_after: startingAfter } });
    return { data: body?.data ?? [], has_more: !!body?.has_more };
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

  async getInvoice(id: string): Promise<StripeInvoice> {
    return (await this.http.request<StripeInvoice>("GET", `/v1/invoices/${encodeURIComponent(id)}`)).body;
  }

  listProducts() {
    return this.listAll<StripeProduct>("/v1/products", { active: "true" });
  }

  async getProduct(id: string): Promise<StripeProduct> {
    return (await this.http.request<StripeProduct>("GET", `/v1/products/${encodeURIComponent(id)}`)).body;
  }

  /** Active prices, optionally for one product. */
  listPrices(product?: string) {
    return this.listAll<StripePrice & { product: string }>("/v1/prices", { product, active: "true" });
  }

  async updateCustomerMetadata(id: string, metadata: Record<string, string>): Promise<StripeCustomer> {
    const form: Record<string, string> = {};
    for (const [k, v] of Object.entries(metadata)) form[`metadata[${k}]`] = v;
    return (await this.http.request<StripeCustomer>("POST", `/v1/customers/${encodeURIComponent(id)}`, { form })).body;
  }

  async createQuote(customer: string, lines: { price: string; quantity: number }[], metadata: Record<string, string>, idempotencyKey: string): Promise<StripeQuote> {
    const form: Record<string, string | number> = { customer };
    lines.forEach((l, i) => {
      form[`line_items[${i}][price]`] = l.price;
      form[`line_items[${i}][quantity]`] = l.quantity;
    });
    for (const [k, v] of Object.entries(metadata)) form[`metadata[${k}]`] = v;
    return (await this.http.request<StripeQuote>("POST", "/v1/quotes", { form, headers: { "Idempotency-Key": idempotencyKey } })).body;
  }

  async getQuote(id: string): Promise<StripeQuote> {
    return (await this.http.request<StripeQuote>("GET", `/v1/quotes/${encodeURIComponent(id)}`)).body;
  }

  async finalizeQuote(id: string): Promise<StripeQuote> {
    return (await this.http.request<StripeQuote>("POST", `/v1/quotes/${encodeURIComponent(id)}/finalize`, { form: {} })).body;
  }

  async createRefund(charge: string, amount: number, metadata: Record<string, string>, idempotencyKey: string): Promise<StripeRefund> {
    const form: Record<string, string | number> = { charge, amount };
    for (const [k, v] of Object.entries(metadata)) form[`metadata[${k}]`] = v;
    return (await this.http.request<StripeRefund>("POST", "/v1/refunds", { form, headers: { "Idempotency-Key": idempotencyKey } })).body;
  }

  async getRefund(id: string): Promise<StripeRefund> {
    return (await this.http.request<StripeRefund>("GET", `/v1/refunds/${encodeURIComponent(id)}`)).body;
  }

  /** Metadata keys are merged; Stripe keeps the ones not sent. */
  async updateSubscriptionMetadata(id: string, metadata: Record<string, string>): Promise<StripeSubscription> {
    const form: Record<string, string> = {};
    for (const [k, v] of Object.entries(metadata)) form[`metadata[${k}]`] = v;
    return (await this.http.request<StripeSubscription>("POST", `/v1/subscriptions/${encodeURIComponent(id)}`, { form })).body;
  }

  /** Cancels now: no proration invoice (refunds follow the cancellation policy instead). */
  async cancelSubscription(id: string): Promise<StripeSubscription> {
    return (await this.http.request<StripeSubscription>("DELETE", `/v1/subscriptions/${encodeURIComponent(id)}`, { form: { invoice_now: "false", prorate: "false" } })).body;
  }

  listPaymentIntents(customer: string) {
    return this.listAll<StripePaymentIntent>("/v1/payment_intents", { customer }, 300);
  }

  async getAccount(id: string): Promise<{ id: string; capabilities?: Record<string, string> | null; requirements?: { disabled_reason?: string | null } | null; payouts_enabled?: boolean | null }> {
    return (await this.http.request<any>("GET", `/v1/accounts/${encodeURIComponent(id)}`)).body;
  }

  /** Connected accounts (Connect), for sweeps across a platform's partners. */
  listAccounts(max = 2000) {
    return this.listAll<StripeConnectedAccount>("/v1/accounts", {}, max);
  }

  async getConnectedAccount(id: string): Promise<StripeConnectedAccount> {
    return (await this.http.request<StripeConnectedAccount>("GET", `/v1/accounts/${encodeURIComponent(id)}`)).body;
  }

  /** Sets a connected account's payout schedule (manual holds funds on the balance). */
  async setPayoutSchedule(id: string, interval: string): Promise<StripeConnectedAccount> {
    return (await this.http.request<StripeConnectedAccount>("POST", `/v1/accounts/${encodeURIComponent(id)}`, { form: { "settings[payouts][schedule][interval]": interval } })).body;
  }

  async updateAccountMetadata(id: string, metadata: Record<string, string>): Promise<StripeConnectedAccount> {
    const form: Record<string, string> = {};
    for (const [k, v] of Object.entries(metadata)) form[`metadata[${k}]`] = v;
    return (await this.http.request<StripeConnectedAccount>("POST", `/v1/accounts/${encodeURIComponent(id)}`, { form })).body;
  }

  listTransfers(transferGroup: string) {
    return this.listAll<StripeTransfer>("/v1/transfers", { transfer_group: transferGroup }, 1000);
  }

  async getTransfer(id: string): Promise<StripeTransfer> {
    return (await this.http.request<StripeTransfer>("GET", `/v1/transfers/${encodeURIComponent(id)}`)).body;
  }

  /** Money to a connected account. The key makes a retried request (e.g. after a lost response) return the same transfer. */
  async createTransfer(t: { amount: number; currency: string; destination: string; transferGroup: string; description: string; metadata: Record<string, string> }, idempotencyKey: string): Promise<StripeTransfer> {
    const form: Record<string, string | number> = { amount: t.amount, currency: t.currency, destination: t.destination, transfer_group: t.transferGroup, description: t.description };
    for (const [k, v] of Object.entries(t.metadata)) form[`metadata[${k}]`] = v;
    return (await this.http.request<StripeTransfer>("POST", "/v1/transfers", { form, headers: { "Idempotency-Key": idempotencyKey } })).body;
  }

  /** Charges a saved payment method now (off session), e.g. an in-app seat purchase. */
  async chargeSavedMethod(p: { customer: string; amount: number; currency: string; paymentMethod: string; description: string; metadata: Record<string, string> }, idempotencyKey: string): Promise<StripePaymentIntent> {
    const form: Record<string, string | number> = { customer: p.customer, amount: p.amount, currency: p.currency, payment_method: p.paymentMethod, confirm: "true", off_session: "true", description: p.description };
    for (const [k, v] of Object.entries(p.metadata)) form[`metadata[${k}]`] = v;
    return (await this.http.request<StripePaymentIntent>("POST", "/v1/payment_intents", { form, headers: { "Idempotency-Key": idempotencyKey } })).body;
  }

  async updatePaymentIntentMetadata(id: string, metadata: Record<string, string>): Promise<StripePaymentIntent> {
    const form: Record<string, string> = {};
    for (const [k, v] of Object.entries(metadata)) form[`metadata[${k}]`] = v;
    return (await this.http.request<StripePaymentIntent>("POST", `/v1/payment_intents/${encodeURIComponent(id)}`, { form })).body;
  }

  async getPaymentIntent(id: string): Promise<StripePaymentIntent> {
    return (await this.http.request<StripePaymentIntent>("GET", `/v1/payment_intents/${encodeURIComponent(id)}`)).body;
  }

  async listRefundsForPaymentIntent(paymentIntent: string): Promise<StripeRefund[]> {
    const refunds = await this.listAll<StripeRefund>("/v1/refunds", { payment_intent: paymentIntent });
    // Some backends ignore the filter; never count another payment's refunds.
    return refunds.filter((r) => r.payment_intent === paymentIntent);
  }

  async refundPaymentIntent(paymentIntent: string, amount: number, metadata: Record<string, string>, idempotencyKey: string): Promise<StripeRefund> {
    const form: Record<string, string | number> = { payment_intent: paymentIntent, amount, reason: "requested_by_customer" };
    for (const [k, v] of Object.entries(metadata)) form[`metadata[${k}]`] = v;
    return (await this.http.request<StripeRefund>("POST", "/v1/refunds", { form, headers: { "Idempotency-Key": idempotencyKey } })).body;
  }

  /** Open and closed disputes; callers match them to their own charges. */
  listDisputes() {
    return this.listAll<{ id: string; charge: string | null; payment_intent?: string | null; status: string }>("/v1/disputes", {}, 500);
  }

  /** Strips personal data but keeps the customer, so invoices and payments stay for the legally required retention period. */
  async anonymizeCustomer(id: string, placeholderEmail: string, metadata: Record<string, string>): Promise<StripeCustomer> {
    const form: Record<string, string> = { email: placeholderEmail, name: "Erased customer", phone: "", description: "" };
    for (const [k, v] of Object.entries(metadata)) form[`metadata[${k}]`] = v;
    return (await this.http.request<StripeCustomer>("POST", `/v1/customers/${encodeURIComponent(id)}`, { form })).body;
  }

  async getBalanceTransaction(customer: string, id: string): Promise<{ id: string; amount: number; currency: string; metadata?: Record<string, string> | null }> {
    return (await this.http.request<any>("GET", `/v1/customers/${encodeURIComponent(customer)}/balance_transactions/${encodeURIComponent(id)}`)).body;
  }

  async createCreditNote(invoice: string, amount: number, reason: string, memo: string): Promise<{ id: string; amount: number }> {
    return (await this.http.request<any>("POST", "/v1/credit_notes", { form: { invoice, amount, reason, memo } })).body;
  }

  /** Negative amount = credit the customer can apply to future invoices. */
  async creditBalance(customer: string, amount: number, currency: string, description: string, idempotencyKey: string, metadata: Record<string, string> = {}): Promise<{ id: string; amount: number }> {
    const form: Record<string, string | number> = { amount: -Math.abs(amount), currency, description };
    for (const [k, v] of Object.entries(metadata)) form[`metadata[${k}]`] = v;
    return (
      await this.http.request<any>("POST", `/v1/customers/${encodeURIComponent(customer)}/balance_transactions`, {
        form,
        headers: { "Idempotency-Key": idempotencyKey },
      })
    ).body;
  }

  /** Total usage a billing meter recorded for one customer in [startSec, endSec) (meter event summaries). */
  async meterUsage(meterId: string, customer: string, startSec: number, endSec: number): Promise<number> {
    let total = 0;
    let after: string | undefined;
    for (;;) {
      const { body } = await this.http.request<{ data: { id: string; aggregated_value: number }[]; has_more: boolean }>("GET", `/v1/billing/meters/${encodeURIComponent(meterId)}/event_summaries`, { query: { customer, start_time: startSec, end_time: endSec, limit: 100, starting_after: after } });
      const page = body?.data ?? [];
      total += page.reduce((t, s) => t + Number(s.aggregated_value ?? 0), 0);
      if (!body?.has_more || !page.length) return total;
      after = page[page.length - 1]!.id;
    }
  }

  /** Draft invoice sent by email (not charged automatically), left in draft until finalized. */
  async createDraftInvoice(customer: string, description: string, daysUntilDue: number, metadata: Record<string, string>, idempotencyKey: string): Promise<StripeInvoice> {
    const form: Record<string, string> = { customer, description, collection_method: "send_invoice", days_until_due: String(daysUntilDue), auto_advance: "false", pending_invoice_items_behavior: "exclude" };
    for (const [k, v] of Object.entries(metadata)) form[`metadata[${k}]`] = v;
    return (await this.http.request<StripeInvoice>("POST", "/v1/invoices", { form, headers: { "Idempotency-Key": idempotencyKey } })).body;
  }

  async addInvoiceLine(invoice: string, customer: string, price: string, quantity: number, description: string, idempotencyKey: string): Promise<{ id: string; amount: number }> {
    return (await this.http.request<any>("POST", "/v1/invoiceitems", { form: { customer, invoice, price, quantity: String(quantity), description }, headers: { "Idempotency-Key": idempotencyKey } })).body;
  }

  async finalizeInvoice(id: string): Promise<StripeInvoice> {
    return (await this.http.request<StripeInvoice>("POST", `/v1/invoices/${encodeURIComponent(id)}/finalize`, { form: { auto_advance: "false" } })).body;
  }

  async sendInvoice(id: string): Promise<StripeInvoice> {
    return (await this.http.request<StripeInvoice>("POST", `/v1/invoices/${encodeURIComponent(id)}/send`, { form: {} })).body;
  }

  /** Retries an open invoice now, optionally with another saved payment method. Declines come back as 402 card errors. */
  async payInvoice(id: string, paymentMethod: string | undefined, idempotencyKey: string): Promise<StripeInvoice> {
    return (await this.http.request<StripeInvoice>("POST", `/v1/invoices/${encodeURIComponent(id)}/pay`, { form: { payment_method: paymentMethod, off_session: "true" }, headers: { "Idempotency-Key": idempotencyKey } })).body;
  }

  async listCardPaymentMethods(customer: string): Promise<{ id: string; card?: { exp_month?: number; exp_year?: number; last4?: string } | null }[]> {
    return (await this.http.request<any>("GET", "/v1/payment_methods", { query: { customer, type: "card", limit: 20 } })).body?.data ?? [];
  }

  /** Payouts that arrived in [from, to) (epoch seconds). */
  listPayouts(fromSec: number, toSec: number) {
    return this.listAll<{ id: string; amount: number; currency: string; arrival_date: number; status: string }>("/v1/payouts", { "arrival_date[gte]": fromSec, "arrival_date[lt]": toSec }, 1_000);
  }

  /** Balance transactions settled in a payout (charges, refunds, fees). */
  payoutTransactions(payout: string) {
    return this.listAll<{ id: string; amount: number; fee: number; type: string; currency: string }>("/v1/balance_transactions", { payout }, 10_000);
  }

  async listBalanceTransactions(customer: string) {
    return (await this.http.request<any>("GET", `/v1/customers/${encodeURIComponent(customer)}/balance_transactions`, { query: { limit: 100 } })).body?.data ?? [];
  }
}

/** Stripe sends epoch seconds; tolerate ISO strings too. */
export function stripeTime(v: number | string | null | undefined): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number") return v * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

/** Monthly recurring revenue of one subscription, in minor units. */
export function subscriptionMrr(sub: StripeSubscription): number {
  return sub.items.data.reduce((sum, it) => {
    const amount = it.price?.unit_amount ?? 0;
    const qty = it.quantity ?? 1;
    const interval = it.price?.recurring?.interval;
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
