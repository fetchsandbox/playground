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

  async getVendor(id: string): Promise<NetSuiteVendor> {
    return (await this.http.request<NetSuiteVendor>("GET", `/services/rest/record/v1/vendor/${encodeURIComponent(id)}`)).body;
  }

  /** PATCH merges the fields sent; NetSuite answers 204. */
  async updateVendor(id: string, fields: Record<string, unknown>): Promise<void> {
    await this.http.request("PATCH", `/services/rest/record/v1/vendor/${encodeURIComponent(id)}`, { json: fields });
  }

  async getVendorBill(id: string): Promise<NetSuiteVendorBill> {
    return (await this.http.request<NetSuiteVendorBill>("GET", `/services/rest/record/v1/vendorBill/${encodeURIComponent(id)}`, { query: { expandSubResources: "true" } })).body;
  }

  async updateVendorBill(id: string, fields: Record<string, unknown>): Promise<void> {
    await this.http.request("PATCH", `/services/rest/record/v1/vendorBill/${encodeURIComponent(id)}`, { json: fields });
  }

  async getPurchaseOrder(id: string): Promise<NetSuitePurchaseOrder> {
    return (await this.http.request<NetSuitePurchaseOrder>("GET", `/services/rest/record/v1/purchaseOrder/${encodeURIComponent(id)}`, { query: { expandSubResources: "true" } })).body;
  }

  /** Purchase orders are found again by external id (the purchase request), so a retry never raises two. */
  async findPurchaseOrder(externalId: string): Promise<{ id: string; tranId?: string } | undefined> {
    const { body } = await this.http.request<any>("GET", "/services/rest/record/v1/purchaseOrder", { query: { q: `externalId IS "${externalId}"`, limit: 5 } });
    const item = body?.items?.[0];
    return item ? { id: String(item.id), tranId: item.tranId } : undefined;
  }

  async createPurchaseOrder(po: { externalId: string; vendorId: string; department: string; memo: string; currency: string; lines: { description: string; amount: number; account: string }[] }): Promise<{ id: string }> {
    const res = await this.http.request<any>("POST", "/services/rest/record/v1/purchaseOrder", {
      json: { externalId: po.externalId, entity: { id: po.vendorId }, department: { id: po.department }, memo: po.memo, currency: { refName: po.currency.toUpperCase() }, expense: { items: po.lines.map((l) => ({ account: { id: l.account }, amount: l.amount, memo: l.description, department: { id: po.department } })) } },
    });
    const id = ((res.headers?.location as string | undefined) ?? "").split("/").pop() || res.body?.id;
    if (!id) throw new Error("NetSuite returned no purchase order id");
    return { id: String(id) };
  }

  /** Journal entries are found again by external id, so a retry never posts twice. */
  async findJournal(externalId: string): Promise<{ id: string } | undefined> {
    const rows = await this.suiteql<{ id: string | number }>(`SELECT id FROM transaction WHERE type = 'Journal' AND externalid = '${externalId.replaceAll("'", "''")}'`);
    return rows[0] ? { id: String(rows[0].id) } : undefined;
  }

  async createJournal(j: { externalId: string; tranDate: string; memo: string; reversalDate?: string; lines: { account: string; debit?: number; credit?: number; memo?: string }[] }): Promise<{ id: string }> {
    const res = await this.http.request<any>("POST", "/services/rest/record/v1/journalEntry", {
      json: { externalId: j.externalId, tranDate: j.tranDate, memo: j.memo, ...(j.reversalDate ? { reversalDate: j.reversalDate, reversalDefer: false } : {}), line: { items: j.lines.map((l) => ({ account: { id: l.account }, debit: l.debit, credit: l.credit, memo: l.memo })) } },
    });
    const id = ((res.headers?.location as string | undefined) ?? "").split("/").pop() || res.body?.id;
    if (!id) throw new Error("NetSuite returned no journal id");
    return { id: String(id) };
  }

  /** Locks an accounting period for AP, AR and all postings. */
  async lockPeriod(periodName: string): Promise<{ id: string }> {
    const [p] = await this.suiteql<{ id: string | number }>(`SELECT id FROM accountingperiod WHERE periodname = '${periodName.replaceAll("'", "''")}'`);
    if (!p) throw new Error(`no accounting period "${periodName}"`);
    await this.http.request("PATCH", `/services/rest/record/v1/accountingPeriod/${p.id}`, { json: { apLocked: true, arLocked: true, allLocked: true } });
    return { id: String(p.id) };
  }

  /** SuiteQL (POST /services/rest/query/v1/suiteql), first page. */
  async suiteql<T = Record<string, unknown>>(q: string): Promise<T[]> {
    const { body } = await this.http.request<{ items?: T[] }>("POST", "/services/rest/query/v1/suiteql", { json: { q }, headers: { Prefer: "transient" }, query: { limit: 1000 } });
    return body?.items ?? [];
  }
}

export interface NetSuiteVendor {
  id: string;
  companyName?: string;
  legalName?: string;
  email?: string | null;
  phone?: string | null;
  dateCreated?: string;
  /** Custom fields ACME keeps on the vendor record. */
  isInactive?: boolean | null;
  custentity_acme_payment_hold?: boolean | null;
  custentity_acme_hold_reason?: string | null;
  custentity_acme_bank_last4?: string | null;
  custentity_acme_bank_token?: string | null;
  custentity_acme_bank_changed_at?: string | null;
}

export interface NetSuiteVendorBill {
  id: string;
  tranId?: string;
  entity?: { id: string };
  total?: number;
  tranDate?: string;
  approvalStatus?: { id: string };
  createdBy?: { id: string } | null;
  custbody_acme_hold_reason?: string | null;
  item?: { items: { item: { id: string }; quantity: number; rate: number; orderDoc?: { id: string } | null; orderLine?: number | null }[] };
}
export interface NetSuitePurchaseOrder {
  id: string;
  tranId?: string;
  entity?: { id: string };
  item?: { items: { line: number; item: { id: string }; quantity: number; quantityReceived: number; quantityBilled: number; rate: number }[] };
}

/** Plaid Identity Match (https://plaid.com/docs/api/products/identity/#identitymatch): does the account owner match? */
export class PlaidClient {
  constructor(readonly http: ProviderHttp, readonly clientId = "", readonly secret = "") {}

  /** Bank transactions in [startDate, endDate]; Plaid amounts are positive for money out, negative for money in. */
  async transactions(accessToken: string, startDate: string, endDate: string): Promise<{ transaction_id: string; amount: number; date: string; name: string; iso_currency_code: string | null }[]> {
    const out: any[] = [];
    for (let offset = 0; ; ) {
      const { body } = await this.http.request<any>("POST", "/transactions/get", { json: { client_id: this.clientId || undefined, secret: this.secret || undefined, access_token: accessToken, start_date: startDate, end_date: endDate, options: { count: 500, offset } } });
      const page = body?.transactions ?? [];
      out.push(...page);
      offset += page.length;
      if (!page.length || offset >= (body?.total_transactions ?? 0)) break;
    }
    return out;
  }

  async identityMatch(accessToken: string, legalName: string): Promise<{ accountId: string; mask: string | null; nameScore: number | null }[]> {
    const { body } = await this.http.request<any>("POST", "/identity/match", { json: { client_id: this.clientId || undefined, secret: this.secret || undefined, access_token: accessToken, user: { legal_name: legalName } } });
    return (body?.accounts ?? []).map((a: any) => ({ accountId: a.account_id, mask: a.mask ?? null, nameScore: a.legal_name?.score ?? null }));
  }
}

/** Twilio Verify (https://www.twilio.com/docs/verify/api): a one-time code by voice call or SMS. */
export class TwilioVerifyClient {
  constructor(readonly http: ProviderHttp, readonly serviceSid: string) {}

  async start(to: string, channel: "call" | "sms"): Promise<{ sid: string; status: string; to: string }> {
    const { body } = await this.http.request<any>("POST", `/v2/Services/${encodeURIComponent(this.serviceSid)}/Verifications`, { form: { To: to, Channel: channel } });
    return { sid: body.sid, status: body.status, to: body.to };
  }

  /** The code the supplier read back to AP. */
  async check(to: string, code: string): Promise<{ status: string; valid: boolean }> {
    const { body } = await this.http.request<any>("POST", `/v2/Services/${encodeURIComponent(this.serviceSid)}/VerificationCheck`, { form: { To: to, Code: code } });
    return { status: body.status, valid: !!body.valid };
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

/** Gusto Embedded Payroll (https://docs.gusto.com/embedded-payroll/reference). */
export class GustoClient {
  constructor(readonly http: ProviderHttp, readonly companyId: string) {}

  async getEmployee(id: string): Promise<{ uuid: string; email?: string | null; terminated?: boolean; terminations?: { uuid: string; effective_date: string }[] }> {
    return (await this.http.request<any>("GET", `/v1/employees/${encodeURIComponent(id)}`)).body;
  }

  async listTerminations(employeeId: string): Promise<{ uuid: string; effective_date: string; active?: boolean }[]> {
    const { body } = await this.http.request<any>("GET", `/v1/employees/${encodeURIComponent(employeeId)}/terminations`);
    return Array.isArray(body) ? body : [];
  }

  async terminate(employeeId: string, effectiveDate: string): Promise<{ uuid: string; effective_date: string }> {
    return (await this.http.request<any>("POST", `/v1/employees/${encodeURIComponent(employeeId)}/terminations`, { json: { effective_date: effectiveDate, run_termination_payroll: true } })).body;
  }

  /** Cancels a termination that hasn't taken effect (rescission). */
  async cancelTermination(employeeId: string): Promise<void> {
    await this.http.request("DELETE", `/v1/employees/${encodeURIComponent(employeeId)}/terminations`);
  }

  /** Off-cycle "dismissed employee" payroll for one person, submitted for the check date. */
  async finalPayroll(p: { employeeId: string; startDate: string; endDate: string; checkDate: string }): Promise<{ uuid: string; check_date: string; processed?: boolean }> {
    const created = (await this.http.request<any>("POST", `/v1/companies/${encodeURIComponent(this.companyId)}/payrolls`, { json: { off_cycle: true, off_cycle_reason: "Dismissed employee", start_date: p.startDate, end_date: p.endDate, check_date: p.checkDate, employee_uuids: [p.employeeId] } })).body;
    await this.http.request("PUT", `/v1/companies/${encodeURIComponent(this.companyId)}/payrolls/${encodeURIComponent(created.uuid ?? created.payroll_uuid)}/submit`, { json: {} });
    return { uuid: created.uuid ?? created.payroll_uuid, check_date: created.check_date ?? p.checkDate, processed: true };
  }

  async listPayrolls(startDate: string): Promise<{ uuid: string; off_cycle?: boolean; check_date?: string; employee_compensations?: { employee_uuid: string }[] }[]> {
    const { body } = await this.http.request<any>("GET", `/v1/companies/${encodeURIComponent(this.companyId)}/payrolls`, { query: { start_date: startDate, include_off_cycle: "true" } });
    return Array.isArray(body) ? body : [];
  }
}
