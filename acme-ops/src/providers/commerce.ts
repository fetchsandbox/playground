import { ProviderError, SpecDeviation } from "../kit/errors";
// AI, storefront, ERP and carrier clients. Each speaks the vendor's own REST
// paths, so the same code runs against production and a FetchSandbox twin.
import type { ProviderHttp } from "../kit/http";

/** OpenAI Chat Completions (https://platform.openai.com/docs/api-reference/chat). Base URL ends in /v1. */
export class OpenAIClient {
  constructor(readonly http: ProviderHttp, readonly model = "gpt-4o-mini") {}

  /** One JSON-mode completion; returns the assistant's text and how the model stopped. */
  async completeJson(system: string, user: string, maxTokens = 600): Promise<{ text: string | null; finishReason: string | null; role: string | null; model: string | null }> {
    const { body } = await this.http.request<any>("POST", "/chat/completions", {
      json: { model: this.model, temperature: 0, max_completion_tokens: maxTokens, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: user }] },
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
  line_items?: { sku?: string | null; title?: string; quantity?: number; price?: string; variant_id?: string | number | null }[];
  created_at?: string;
  shipping_address?: { name?: string; address1?: string; city?: string; province_code?: string; province?: string; zip?: string; country_code?: string; country?: string } | null;
}

/** Shopify Admin REST (https://shopify.dev/docs/api/admin-rest). */
export class ShopifyClient {
  /** Default Admin API version: inside Shopify's 12-month support window as of 2026-10. */
  constructor(readonly http: ProviderHttp, readonly version = "2026-01") {}

  /** Shopify authenticates with X-Shopify-Access-Token (twins accept the bearer token too). */
  private req<T>(method: string, p: string, opts: { json?: unknown; query?: Record<string, string | number | undefined> } = {}) {
    return this.http.request<T>(method, `/admin/api/${this.version}${p}`, { ...opts, headers: { "X-Shopify-Access-Token": this.http.endpoint.token } });
  }

  /** Orders created since `createdAtMin`, any status, paged by since_id. */
  async ordersSince(createdAtMin: string, max = 5000): Promise<ShopifyOrder[]> {
    const out: ShopifyOrder[] = [];
    let sinceId: string | undefined;
    while (out.length < max) {
      const { body } = await this.req<any>("GET", "/orders.json", { query: { status: "any", created_at_min: createdAtMin, limit: 250, since_id: sinceId, fields: "id,created_at,cancelled_at,line_items" } });
      const page: ShopifyOrder[] = body?.orders ?? [];
      out.push(...page);
      if (page.length < 250) break;
      sinceId = String(page[page.length - 1]!.id);
    }
    return out.slice(0, max);
  }

  async getVariant(id: string | number): Promise<{ id: string | number; sku?: string | null; inventory_item_id: string | number }> {
    const { body } = await this.req<any>("GET", `/variants/${encodeURIComponent(String(id))}.json`);
    return body.variant;
  }

  /** Available units per inventory item at one location. */
  async available(inventoryItemIds: (string | number)[], locationId: string | number): Promise<Record<string, number>> {
    // inventory_item_ids takes at most 50 ids; `available` is null for untracked items, which are left out.
    const out: Record<string, number> = {};
    for (let i = 0; i < inventoryItemIds.length; i += 50) {
      const { body } = await this.req<any>("GET", "/inventory_levels.json", { query: { inventory_item_ids: inventoryItemIds.slice(i, i + 50).join(","), location_ids: String(locationId), limit: 250 } });
      for (const l of body?.inventory_levels ?? []) if (l.available !== null && l.available !== undefined) out[String(l.inventory_item_id)] = Number(l.available);
    }
    return out;
  }

  /** A free replacement: a draft order at 100% discount, completed into an order. */
  async createReplacement(r: { lineItems: { variant_id: string | number; quantity: number }[]; email: string | null; note: string; tags: string[] }): Promise<{ draftId: string | number; orderId: string | number | null }> {
    const { body } = await this.req<any>("POST", "/draft_orders.json", {
      json: { draft_order: { line_items: r.lineItems, email: r.email ?? undefined, note: r.note, tags: r.tags.join(", "), applied_discount: { value_type: "percentage", value: "100.0", title: "Replacement" }, shipping_line: { title: "Replacement shipping", price: "0.00" } } },
    });
    const draft = body.draft_order;
    const done = await this.req<any>("PUT", `/draft_orders/${encodeURIComponent(String(draft.id))}/complete.json`, { query: { payment_pending: "false" } });
    return { draftId: draft.id, orderId: done.body?.draft_order?.order_id ?? null };
  }

  async getOrder(id: string | number): Promise<ShopifyOrder> {
    const { body } = await this.req<any>("GET", `/orders/${encodeURIComponent(String(id))}.json`);
    return body.order;
  }

  async listFulfillments(orderId: string | number): Promise<{ id: string | number; tracking_number?: string | null; tracking_numbers?: string[]; status?: string }[]> {
    const { body } = await this.req<any>("GET", `/orders/${encodeURIComponent(String(orderId))}/fulfillments.json`);
    return body?.fulfillments ?? [];
  }

  /**
   * Fulfils every open fulfillment order of the order with one tracking number
   * (fulfillment-order flow; the order-based create was removed in 2022-07).
   */
  async createFulfillment(orderId: string | number, f: { trackingNumber: string; trackingCompany: string; trackingUrl?: string }): Promise<{ id: string | number }> {
    const { body: fo } = await this.req<any>("GET", `/orders/${encodeURIComponent(String(orderId))}/fulfillment_orders.json`);
    const open = (fo?.fulfillment_orders ?? []).filter((x: any) => ["open", "in_progress"].includes(x.status));
    if (!open.length) throw new SpecDeviation("shopify", `order ${orderId} has no open fulfillment order to fulfil`);
    const { body } = await this.req<any>("POST", "/fulfillments.json", {
      json: { fulfillment: { line_items_by_fulfillment_order: open.map((x: any) => ({ fulfillment_order_id: x.id })), tracking_info: { number: f.trackingNumber, company: f.trackingCompany, ...(f.trackingUrl ? { url: f.trackingUrl } : {}) }, notify_customer: true } },
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

  /** A record by its external id (`/record/v1/{type}/eid:{externalId}`), or undefined on 404. */
  private async byExternalId(type: string, externalId: string): Promise<{ id: string; tranId?: string } | undefined> {
    const res = await this.http.request<any>("GET", `/services/rest/record/v1/${type}/eid:${encodeURIComponent(externalId)}`, { allow: [404] });
    return res.status === 404 ? undefined : { id: String(res.body.id), tranId: res.body.tranId };
  }

  /** Sales orders whose external id is ours (the storefront order). */
  findSalesOrder(externalId: string) {
    return this.byExternalId("salesOrder", externalId);
  }

  /** The customer whose email is exactly this one (record references take ids, not emails). */
  async findCustomerId(email: string): Promise<string | undefined> {
    const rows = await this.suiteql<{ id: string | number }>(`SELECT id FROM customer WHERE email = '${email.replaceAll("'", "''")}' AND isinactive = 'F'`);
    return rows[0] ? String(rows[0].id) : undefined;
  }

  /** Creates the sales order; NetSuite answers 204 with the new record in Location. */
  /** Creates the sales order for an existing customer (by internal id); the order takes the customer's currency. */
  async createSalesOrder(so: { externalId: string; customerId: string; lines: { sku: string; quantity: number; rate: number }[]; memo: string }): Promise<{ id: string }> {
    const res = await this.http.request<any>("POST", "/services/rest/record/v1/salesOrder", {
      json: { externalId: so.externalId, entity: { id: so.customerId }, memo: so.memo, item: { items: so.lines.map((l) => ({ item: { externalId: l.sku }, quantity: l.quantity, rate: l.rate })) } },
    });
    const loc = (res.headers?.location as string | undefined) ?? "";
    const id = loc.split("/").pop();
    if (!id) throw new SpecDeviation("netsuite", "sales order create returned no Location header");
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
  findPurchaseOrder(externalId: string) {
    return this.byExternalId("purchaseOrder", externalId);
  }

  /** The PO takes the vendor's currency. */
  async createPurchaseOrder(po: { externalId: string; vendorId: string; department: string; memo: string; lines?: { description: string; amount: number; account: string }[]; items?: { item: string; quantity: number; rate: number }[]; dueDate?: string }): Promise<{ id: string }> {
    const res = await this.http.request<any>("POST", "/services/rest/record/v1/purchaseOrder", {
      json: {
        externalId: po.externalId,
        entity: { id: po.vendorId },
        department: { id: po.department },
        memo: po.memo,
        ...(po.dueDate ? { dueDate: po.dueDate } : {}),
        ...(po.lines?.length ? { expense: { items: po.lines.map((l) => ({ account: { id: l.account }, amount: l.amount, memo: l.description, department: { id: po.department } })) } } : {}),
        ...(po.items?.length ? { item: { items: po.items.map((l) => ({ item: { id: l.item }, quantity: l.quantity, rate: l.rate })) } } : {}),
      },
    });
    const id = ((res.headers?.location as string | undefined) ?? "").split("/").pop() || res.body?.id;
    if (!id) throw new Error("NetSuite returned no purchase order id");
    return { id: String(id) };
  }

  /** Units on open purchase orders not yet received, per NetSuite item id. */
  async incomingByItem(itemIds: string[]): Promise<Record<string, number>> {
    if (!itemIds.length) return {};
    const rows = await this.suiteql<{ item: string | number; open: number | string }>(
      `SELECT tl.item AS item, SUM(tl.quantity - NVL(tl.quantityshiprecv, 0)) AS open FROM transaction t JOIN transactionline tl ON tl.transaction = t.id WHERE t.type = 'PurchOrd' AND BUILTIN.CF(t.status) IN ('PurchOrd:B', 'PurchOrd:D', 'PurchOrd:E') AND tl.item IN (${itemIds.map((i) => Number(i)).join(", ")}) GROUP BY tl.item`,
    );
    return Object.fromEntries(rows.map((r) => [String(r.item), Number(r.open ?? 0)]));
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
  /** All rows, following `hasMore` with offset (Prefer: transient is required for SuiteQL). */
  async suiteql<T = Record<string, unknown>>(q: string, max = 10_000): Promise<T[]> {
    const out: T[] = [];
    for (let offset = 0; out.length < max; ) {
      const { body } = await this.http.request<{ items?: T[]; hasMore?: boolean }>("POST", "/services/rest/query/v1/suiteql", { json: { q }, headers: { Prefer: "transient" }, query: { limit: 1000, offset } });
      const page = body?.items ?? [];
      out.push(...page);
      offset += page.length;
      if (!body?.hasMore || !page.length) break;
    }
    return out.slice(0, max);
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

export interface GustoPayroll {
  uuid?: string;
  payroll_uuid?: string;
  version?: string;
  processed?: boolean;
  off_cycle?: boolean;
  check_date?: string;
  payroll_deadline?: string;
  calculated_at?: string | null;
  pay_period?: { start_date?: string; end_date?: string };
  employee_compensations?: { employee_uuid: string; gross_pay?: string | null; net_pay?: string | null; excluded?: boolean }[];
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

  /** Tracker with its scan history (https://docs.easypost.com/docs/trackers). */
  async getTracker(id: string): Promise<{ id: string; status: string; tracking_code: string; carrier?: string; est_delivery_date?: string | null; tracking_details?: { datetime: string; status: string; message?: string | null }[] }> {
    return (await this.http.request<any>("GET", `/trackers/${encodeURIComponent(id)}`)).body;
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
  /**
   * Final pay as an off-cycle "Dismissed employee" payroll: create, calculate (async; poll until
   * calculated_at), then submit (async, 202). Returns the payroll as submitted, not as processed.
   */
  async finalPayroll(p: { employeeId: string; startDate: string; endDate: string; checkDate: string }, pollMs = 2_000, polls = 15): Promise<{ uuid: string; check_date: string; processed: boolean }> {
    const base = `/v1/companies/${encodeURIComponent(this.companyId)}/payrolls`;
    const created = (await this.http.request<any>("POST", base, { json: { off_cycle: true, off_cycle_reason: "Dismissed employee", start_date: p.startDate, end_date: p.endDate, check_date: p.checkDate, employee_uuids: [p.employeeId] } })).body;
    const id = created.uuid ?? created.payroll_uuid;
    await this.http.request("PUT", `${base}/${encodeURIComponent(id)}/calculate`, { json: {} });
    let cur = await this.getPayroll(id);
    for (let i = 0; !cur.calculated_at && i < polls; i++) {
      await new Promise((r) => setTimeout(r, pollMs));
      cur = await this.getPayroll(id);
    }
    if (!cur.calculated_at) throw new ProviderError("gusto", 0, "calculation_pending", true, `payroll ${id} not calculated yet`);
    await this.submitPayroll(id);
    return { uuid: id, check_date: created.check_date ?? p.checkDate, processed: false };
  }

  /** One payroll with per-employee compensation (gross and net pay as decimal strings). */
  async getPayroll(id: string): Promise<GustoPayroll> {
    return (await this.http.request<GustoPayroll>("GET", `/v1/companies/${encodeURIComponent(this.companyId)}/payrolls/${encodeURIComponent(id)}`, { query: { include: "taxes,benefits,deductions" } })).body;
  }

  /** Excludes employees from an unprocessed payroll; `version` guards concurrent edits (409 on mismatch). */
  /** Prepares the payroll for editing (returns the current `version`), then excludes the employees (max 100 per call). */
  async excludeEmployees(id: string, employeeIds: string[]): Promise<GustoPayroll> {
    const base = `/v1/companies/${encodeURIComponent(this.companyId)}/payrolls/${encodeURIComponent(id)}`;
    let last: GustoPayroll | undefined;
    for (let i = 0; i < employeeIds.length; i += 100) {
      const prepared = (await this.http.request<GustoPayroll>("PUT", `${base}/prepare`, { json: {} })).body;
      last = (await this.http.request<GustoPayroll>("PUT", base, { json: { version: prepared.version, employee_compensations: employeeIds.slice(i, i + 100).map((u) => ({ employee_uuid: u, excluded: true })) } })).body;
    }
    return last!;
  }

  async submitPayroll(id: string): Promise<void> {
    await this.http.request("PUT", `/v1/companies/${encodeURIComponent(this.companyId)}/payrolls/${encodeURIComponent(id)}/submit`, { json: {} });
  }

  async listEmployees(): Promise<{ uuid: string; first_name?: string; last_name?: string; terminated?: boolean; terminations?: { effective_date: string }[]; jobs?: { hire_date?: string }[] }[]> {
    const out: any[] = [];
    for (let page = 1; ; page++) {
      const { body } = await this.http.request<any>("GET", `/v1/companies/${encodeURIComponent(this.companyId)}/employees`, { query: { page, per: 100 } });
      const rows = Array.isArray(body) ? body : [];
      out.push(...rows);
      if (rows.length < 100) return out;
    }
  }

  async listPayrolls(startDate: string): Promise<{ uuid: string; off_cycle?: boolean; check_date?: string; employee_compensations?: { employee_uuid: string }[] }[]> {
    // Defaults are processed regular payrolls only; ask for unprocessed and off-cycle ones too, every page.
    const out: any[] = [];
    for (let page = 1; ; page++) {
      const { body } = await this.http.request<any>("GET", `/v1/companies/${encodeURIComponent(this.companyId)}/payrolls`, { query: { start_date: startDate, processing_statuses: "unprocessed,processed", payroll_types: "regular,off_cycle", include_off_cycle: "true", page, per: 100 } });
      const rows = Array.isArray(body) ? body : [];
      out.push(...rows);
      if (rows.length < 100) return out;
    }
  }
}
