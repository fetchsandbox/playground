import type { ProviderHttp } from "../kit/http";

export interface PaymentOrder {
  id: string;
  type: string;
  amount: number;
  currency: string;
  direction: string;
  status: string;
  originating_account_id: string;
  receiving_account_id: string;
  effective_date?: string;
  created_at?: string;
  metadata?: Record<string, string>;
}
export interface ExternalAccount {
  id: string;
  counterparty_id: string;
  verification_status: string;
  created_at: string;
  party_name?: string;
}

/**
 * Modern Treasury (https://docs.moderntreasury.com/platform/reference): payment
 * orders over wire/ACH from ACME's bank accounts. Auth on the vendor host is
 * Basic organization-id:api-key; creates take an Idempotency-Key.
 */
export class ModernTreasuryClient {
  constructor(readonly http: ProviderHttp) {}

  async getExternalAccount(id: string): Promise<ExternalAccount> {
    return (await this.http.request<ExternalAccount>("GET", `/api/external_accounts/${encodeURIComponent(id)}`)).body;
  }

  async getCounterparty(id: string): Promise<{ id: string; name: string; created_at?: string }> {
    return (await this.http.request<any>("GET", `/api/counterparties/${encodeURIComponent(id)}`)).body;
  }

  /** Payment orders matching the filters, following `after_cursor` pages (X-After-Cursor header). */
  async listPaymentOrders(filters: Record<string, string>, max = 500): Promise<PaymentOrder[]> {
    const out: PaymentOrder[] = [];
    let after: string | undefined;
    while (out.length < max) {
      const res = await this.http.request<PaymentOrder[]>("GET", "/api/payment_orders", { query: { ...filters, per_page: 100, after_cursor: after } });
      const page = Array.isArray(res.body) ? res.body : [];
      out.push(...page);
      // Pages may be blank while a cursor remains; follow X-After-Cursor until it is absent.
      after = (res.headers?.["x-after-cursor"] as string | undefined) || undefined;
      if (!after) break;
    }
    return out.slice(0, max);
  }

  async createPaymentOrder(p: { type: "wire" | "ach"; amount: number; currency: string; originatingAccountId: string; receivingAccountId: string; description: string; effectiveDate: string; metadata: Record<string, string> }, idempotencyKey: string): Promise<PaymentOrder> {
    const { body } = await this.http.request<PaymentOrder>("POST", "/api/payment_orders", {
      json: { type: p.type, amount: p.amount, currency: p.currency.toUpperCase(), direction: "credit", originating_account_id: p.originatingAccountId, receiving_account_id: p.receivingAccountId, description: p.description, effective_date: p.effectiveDate, metadata: p.metadata },
      headers: { "Idempotency-Key": idempotencyKey },
    });
    return body;
  }

  async getPaymentOrder(id: string): Promise<PaymentOrder> {
    return (await this.http.request<PaymentOrder>("GET", `/api/payment_orders/${encodeURIComponent(id)}`)).body;
  }
}
