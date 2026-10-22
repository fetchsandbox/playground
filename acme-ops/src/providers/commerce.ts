// AI, storefront, ERP and carrier clients. Each speaks the vendor's own REST
// paths, so the same code runs against production and a FetchSandbox twin.
import type { ProviderHttp } from "../kit/http";

/** OpenAI Chat Completions (https://platform.openai.com/docs/api-reference/chat). Base URL ends in /v1. */
export class OpenAIClient {
  constructor(readonly http: ProviderHttp, readonly model = "gpt-4o-mini") {}

  /** One JSON-mode completion; returns the assistant's text and how the model stopped. */
  async completeJson(system: string, user: string, maxTokens = 600): Promise<{ text: string | null; finishReason: string | null; role: string | null; model: string | null }> {
    const { body } = await this.http.request<any>("POST", "/chat/completions", {
      json: { model: this.model, temperature: 0, max_tokens: maxTokens, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: user }] },
    });
    const choice = body?.choices?.[0];
    return { text: typeof choice?.message?.content === "string" ? choice.message.content : null, finishReason: choice?.finish_reason ?? null, role: choice?.message?.role ?? null, model: body?.model ?? null };
  }
}

export interface ShopifyOrder {
  id: string | number;
  name?: string;
  email?: string | null;
  financial_status?: string | null;
  fulfillment_status?: string | null;
  cancelled_at?: string | null;
  currency?: string;
  total_price?: string;
  tags?: string;
  line_items?: { sku?: string | null; title?: string; quantity?: number; price?: string }[];
  shipping_address?: { name?: string; address1?: string; city?: string; province_code?: string; province?: string; zip?: string; country_code?: string; country?: string } | null;
}

/** Shopify Admin REST (https://shopify.dev/docs/api/admin-rest). */
export class ShopifyClient {
  constructor(readonly http: ProviderHttp, readonly version = "2024-10") {}

  /** Shopify authenticates with X-Shopify-Access-Token (twins accept the bearer token too). */
  private req<T>(method: string, p: string, opts: { json?: unknown } = {}) {
    return this.http.request<T>(method, `/admin/api/${this.version}${p}`, { ...opts, headers: { "X-Shopify-Access-Token": this.http.endpoint.token } });
  }

  async getOrder(id: string | number): Promise<ShopifyOrder> {
    const { body } = await this.req<any>("GET", `/orders/${encodeURIComponent(String(id))}.json`);
    return body.order;
  }

  async listFulfillments(orderId: string | number): Promise<{ id: string | number; tracking_number?: string | null; tracking_numbers?: string[]; status?: string }[]> {
    const { body } = await this.req<any>("GET", `/orders/${encodeURIComponent(String(orderId))}/fulfillments.json`);
    return body?.fulfillments ?? [];
  }

  async createFulfillment(orderId: string | number, f: { trackingNumber: string; trackingCompany: string; trackingUrl?: string }): Promise<{ id: string | number }> {
    const { body } = await this.req<any>("POST", `/orders/${encodeURIComponent(String(orderId))}/fulfillments.json`, {
      json: { fulfillment: { tracking_number: f.trackingNumber, tracking_company: f.trackingCompany, tracking_url: f.trackingUrl, notify_customer: true } },
    });
    return body.fulfillment;
  }

  async addTags(orderId: string | number, tags: string[]): Promise<ShopifyOrder> {
    const cur = await this.getOrder(orderId);
    const merged = [...new Set([...(cur.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean), ...tags])].join(", ");
    const { body } = await this.req<any>("PUT", `/orders/${encodeURIComponent(String(orderId))}.json`, { json: { order: { id: orderId, tags: merged } } });
    return body.order;
  }
}

/** NetSuite SuiteTalk REST record API (https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/book_1559132836.html). */
export class NetSuiteClient {
  constructor(readonly http: ProviderHttp) {}

  /** Sales orders whose external id is ours (the storefront order). */
  async findSalesOrder(externalId: string): Promise<{ id: string; tranId?: string } | undefined> {
    const { body } = await this.http.request<any>("GET", "/services/rest/record/v1/salesOrder", { query: { q: `externalId IS "${externalId}"`, limit: 5 } });
    const item = body?.items?.[0];
    return item ? { id: String(item.id), tranId: item.tranId } : undefined;
  }

  /** Creates the sales order; NetSuite answers 204 with the new record in Location. */
  async createSalesOrder(so: { externalId: string; customerEmail: string; currency: string; lines: { sku: string; quantity: number; rate: number }[]; memo: string }): Promise<{ id: string }> {
    const res = await this.http.request<any>("POST", "/services/rest/record/v1/salesOrder", {
      json: { externalId: so.externalId, entity: { email: so.customerEmail }, currency: { refName: so.currency.toUpperCase() }, memo: so.memo, item: { items: so.lines.map((l) => ({ item: { externalId: l.sku }, quantity: l.quantity, rate: l.rate })) } },
      headers: { Prefer: "transient" },
    });
    const loc = (res.headers?.location as string | undefined) ?? "";
    const id = loc.split("/").pop() || res.body?.id;
    if (!id) throw new Error("NetSuite returned no sales order id");
    return { id: String(id) };
  }

  async getSalesOrder(id: string): Promise<{ id: string; externalId?: string; status?: { id?: string } }> {
    return (await this.http.request<any>("GET", `/services/rest/record/v1/salesOrder/${encodeURIComponent(id)}`)).body;
  }
}

/** EasyPost shipping (https://docs.easypost.com/docs/shipments). Base URL ends in /v2. */
export class EasyPostClient {
  constructor(readonly http: ProviderHttp) {}

  async createShipment(s: { reference: string; to: Record<string, string | undefined>; from: Record<string, string>; parcel: { weight: number } }): Promise<{ id: string; rates: { id: string; carrier: string; service: string; rate: string; currency: string }[] }> {
    const { body } = await this.http.request<any>("POST", "/shipments", { json: { shipment: { reference: s.reference, to_address: s.to, from_address: s.from, parcel: s.parcel } } });
    return { id: body.id, rates: body.rates ?? [] };
  }

  async buy(shipmentId: string, rateId: string, idempotencyKey: string): Promise<{ id: string; tracking_code: string | null; postage_label?: { label_url?: string } | null; selected_rate?: { carrier?: string; rate?: string } | null }> {
    const { body } = await this.http.request<any>("POST", `/shipments/${encodeURIComponent(shipmentId)}/buy`, { json: { rate: { id: rateId } }, headers: { "Idempotency-Key": idempotencyKey } });
    return body;
  }

  async getShipment(id: string): Promise<{ id: string; reference?: string; tracking_code?: string | null; status?: string }> {
    return (await this.http.request<any>("GET", `/shipments/${encodeURIComponent(id)}`)).body;
  }
}
