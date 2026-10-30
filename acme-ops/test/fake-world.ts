// One in-process HTTP server that speaks just enough of Stripe, HubSpot,
// Gmail, Calendar, Slack, Zendesk and Square for the workflows, with state, request
// recording and fault injection. Tests run the real provider clients against it.
import { type AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { Engine, type EngineDeps } from "../src/kit/engine";
import { templateDrafter } from "../src/kit/drafter";
import { silentLogger } from "../src/kit/log";
import { MemoryStore, type KvStore } from "../src/kit/store";
import type { WorkflowDef } from "../src/kit/types";
import { type ProviderName, providerFactory } from "../src/providers";

export interface Fault {
  method: string;
  path: RegExp;
  status: number;
  body: unknown;
  /** How many requests to fail (default: all). */
  times?: number;
}

export interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

let seq = 1000;
const id = (p: string) => `${p}_${++seq}`;

export function seedState() {
  return {
    meta: {ads:[] as any[],creatives:[{id:"3001",account_id:"1001",name:"Pergola TEST",object_story_spec:{page_id:"4001",link_data:{message:"Plan your outdoor space",link:"https://example.test/pergolas"}}}] as any[],loseResponses:0,hideAds:false},
    stripe: {
      customers: [
        { id: "cus_alice", email: "alice@acmecorp.com", name: "Alice" },
        { id: "cus_dev", email: "dev@startupxyz.io", name: "Dev" },
      ] as any[],
      prices: [
        { id: "price_pro_monthly", active: true, currency: "usd", unit_amount: 4900, recurring: { interval: "month" } },
        { id: "price_retired", active: false, currency: "usd", unit_amount: 1000, recurring: { interval: "month" } },
      ] as any[],
      subscriptions: [] as any[],
      invoices: [{ id: "in_dev_open", customer: "cus_dev", status: "open", amount_due: 4900, amount_remaining: 4900, currency: "usd" }] as any[],
      refunds: [{ id: "re_1", amount: 4900, currency: "usd", charge: "ch_alice_1", status: "succeeded" }] as any[],
      products: [] as any[],
      paymentIntents: [] as any[],
      balanceTxns: [] as any[],
      paymentMethods: [] as any[],
      payouts: [] as any[],
      payoutTxns: [] as any[],
      /** Behave like a backend that ignores starting_after. */
      ignoreCursor: false,
      disputes: [] as any[],
      meterEvents: [] as { meter: string; customer: string; ts: number; value: number }[],
      invoiceItems: [] as any[],
      keys: new Map<string, any>(),
      accounts: [] as any[],
      transfers: [] as any[],
      /** Idempotency-Key → transfer, as real Stripe keeps for 24h. */
      transferKeys: new Map<string, any>(),
      /** Lose this many transfer responses after the transfer was created (the effect happens, the reply doesn't). */
      loseTransferResponses: 0,
    },
    hubspot: { contacts: [] as any[], subscriptions: new Map<string, string>() },
    gmail: { messages: [] as { from: string }[], drafts: [] as any[] },
    calendar: { busy: [] as { start: string; end: string }[], events: [] as any[] },
    slack: { channels: new Set(["C0SUPPORT1", "C0FINANCE1", "C0CSOPS001", "C0ONBOARD1"]), messages: [] as any[] },
    zendesk: { tickets: [] as any[], comments: [] as any[], users: [] as any[], orgs: [] as any[] },
    workos: { users: [] as any[], memberships: [] as any[], sessions: [] as any[] },
    notion: { pages: [] as any[] },
    asana: { tasks: [] as any[], stories: [] as { task: string; text: string }[] },
    shopify: { drafts: [] as any[], orders: [] as any[], fulfillments: [] as any[], variants: [] as any[], levels: [] as { inventory_item_id: number; location_id: number; available: number }[] },
    gusto: { terminations: [] as any[], payrolls: [] as any[], employees: [] as any[] },
    box: { files: [] as { id: string; name: string; text: string | null; folder?: string; content?: string; sharedLink?: { url: string; unshared_at: string } }[] },
    docusign: { envelopes: [] as any[] },
    dependabot: [] as { repo: string; number: number; state: string; created_at: string; security_advisory: { ghsa_id: string; severity: string; summary: string }; dependency: { package: { name: string; ecosystem: string } }; dismissed_reason?: string }[],
    issues: [] as { repo: string; number: number; title: string; body?: string; state: string; labels: string[]; comments: string[] }[],
    gh: { pulls: [] as any[], reviews: [] as any[], checkRuns: [] as any[], deployments: [] as any[], statuses: [] as any[] },
    pagerduty: { incidents: [] as any[] },
    moderntreasury: { externalAccounts: [] as any[], counterparties: [] as any[], orders: [] as any[], keys: new Map<string, any>() },
    datadog: { monitors: [] as any[], errorRate: 0.4 },
    github: { members: [] as { org: string; login: string; id: number; role: "admin" | "member" }[] },
    netsuite: { customers: [{ id: "7001", email: "buyer@example.com" }] as { id: string; email: string }[], salesOrders: [] as any[], vendors: [] as any[], bills: [] as any[], vendorBills: [] as any[], purchaseOrders: [] as any[], journals: [] as any[], periods: [] as any[], unbilledReceipts: 0 },
    plaid: { accounts: {} as Record<string, { account_id: string; mask: string; legal_name: { score: number } }[]>, transactions: {} as Record<string, any[]> },
    verify: { verifications: [] as any[] },
    screening: { entries: [] as { name: string; source: string; score?: number }[] },
    easypost: { trackers: [] as any[], shipments: [] as any[], rates: [{ carrier: "USPS", service: "Ground", rate: "7.40", currency: "USD" }, { carrier: "UPS", service: "Ground", rate: "9.10", currency: "USD" }] as any[] },
    /** Scripted model answers, used in order; then a how-to default. */
    openai: { replies: [] as { content: string; role?: string }[], calls: [] as any[] },
    square: { locations: [{ id: "LOC_MAIN", status: "ACTIVE", currency: "USD" }] as any[], giftCards: [] as any[], activities: [] as any[] },
  };
}

export type WorldState = ReturnType<typeof seedState>;

export function addSub(state: WorldState, customer: string, priceId: string, status: string, quantity = 1) {
  const price = state.stripe.prices.find((p) => p.id === priceId);
  const sub = { id: id("sub"), customer, status, cancel_at_period_end: false, items: { data: [{ price, quantity }] }, metadata: {} };
  state.stripe.subscriptions.push(sub);
  return sub;
}

export async function startWorld() {
  const state = seedState();
  const faults: Fault[] = [];
  const requests: Recorded[] = [];
  // Stripe returns `incomplete` until the first invoice is paid (no payment method yet).
  let newSubStatus = "active";

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const q = url.searchParams;
    let body: any = {};
    if (raw) body = String(req.headers["content-type"]).includes("json") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    requests.push({ method: req.method!, path, headers: req.headers, body });
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };

    const fault = faults.find((f) => f.method === req.method && f.path.test(path) && (f.times ?? 1) > 0);
    if (fault) {
      if (fault.times !== undefined) fault.times--;
      return send(fault.status, fault.body);
    }

    const m = (re: RegExp) => re.exec(path);
    let r: RegExpExecArray | null;
    const S = state.stripe;

    // ---- Stripe
    if (req.method === "GET" && path === "/v1/customers") {
      const email = q.get("email");
      const all = S.customers.filter((c) => !email || c.email === email);
      // Real cursor pagination only when a limit is asked for (older tests list everything at once).
      if (!q.get("limit") || email) return send(200, { data: all, has_more: false });
      const limit = Number(q.get("limit"));
      const from = q.get("starting_after") && !S.ignoreCursor ? all.findIndex((c) => c.id === q.get("starting_after")) + 1 : 0;
      const page = all.slice(from, from + limit);
      return send(200, { data: page, has_more: S.ignoreCursor ? all.length > limit : from + limit < all.length });
    }
    if (req.method === "POST" && path === "/v1/customers") {
      const metadata = Object.fromEntries(Object.entries(body).filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v]));
      const c = { id: id("cus"), email: body.email, name: body.name, metadata };
      S.customers.push(c);
      return send(200, c);
    }
    const meta = () => Object.fromEntries(Object.entries(body).filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v]));
    if (req.method === "POST" && (r = m(/^\/v1\/customers\/([^/]+)$/))) {
      const c = S.customers.find((x) => x.id === r![1]);
      if (!c) return send(404, { error: { code: "resource_missing" } });
      c.metadata = { ...c.metadata, ...meta() };
      for (const k of ["email", "name", "phone", "description"]) if (k in body) c[k] = body[k];
      return send(200, c);
    }
    if ((r = m(/^\/v1\/customers\/([^/]+)\/balance_transactions(?:\/([^/]+))?$/))) {
      if (req.method === "POST") {
        const owner = S.customers.find((x) => x.id === r![1]);
        if (owner?.currency && owner.currency.toLowerCase() !== String(body.currency).toLowerCase()) return send(400, { error: { type: "invalid_request_error", code: "currency_mismatch", message: "Customer balance currency differs" } });
        const tx = { id: id("cbtxn"), customer: r[1], amount: Number(body.amount), currency: body.currency, description: body.description, metadata: meta() };
        S.balanceTxns.push(tx);
        return send(200, tx);
      }
      if (r[2]) {
        const tx = S.balanceTxns.find((x) => x.id === r![2] && x.customer === r![1]);
        return tx ? send(200, tx) : send(404, { error: { code: "resource_missing" } });
      }
      return send(200, { data: S.balanceTxns.filter((x) => x.customer === r![1]), has_more: false });
    }
    if (req.method === "GET" && (r = m(/^\/v1\/customers\/([^/]+)$/))) {
      const c = S.customers.find((x) => x.id === r![1]);
      return c ? send(200, c) : send(404, { error: { code: "resource_missing" } });
    }
    if (req.method === "GET" && (r = m(/^\/v1\/prices\/([^/]+)$/))) {
      const p = S.prices.find((x) => x.id === r![1]);
      return p ? send(200, p) : send(404, { error: { code: "resource_missing" } });
    }
    if (req.method === "GET" && path === "/v1/subscriptions") {
      const cus = q.get("customer");
      const status = q.get("status");
      // Stripe: no status → everything except canceled.
      const keep = (s: any) => (status ? s.status === status : s.status !== "canceled");
      return send(200, { data: S.subscriptions.filter((s) => (!cus || s.customer === cus) && keep(s)), has_more: false });
    }
    if (req.method === "POST" && path === "/v1/subscriptions") {
      return send(200, addSub(state, body.customer, body["items[0][price]"], newSubStatus, Number(body["items[0][quantity]"])));
    }
    if ((r = m(/^\/v1\/subscriptions\/([^/]+)$/))) {
      const s = S.subscriptions.find((x) => x.id === r![1]);
      if (!s) return send(404, { error: { code: "resource_missing" } });
      if (req.method === "POST") s.metadata = { ...s.metadata, ...meta() };
      if (req.method === "DELETE") {
        if (s.status === "canceled") return send(400, { error: { code: "resource_missing", message: "already canceled" } });
        s.status = s.status === "incomplete" ? "incomplete_expired" : "canceled";
        s.canceled_at = Math.floor(Date.now() / 1000);
      }
      return send(200, s);
    }
    if (req.method === "GET" && (r = m(/^\/v1\/products\/([^/]+)$/))) {
      const p = S.products.find((x) => x.id === r![1]);
      return p ? send(200, p) : send(404, { error: { code: "resource_missing" } });
    }
    if (req.method === "POST" && (r = m(/^\/v1\/invoices\/([^/]+)\/pay$/))) {
      const i = S.invoices.find((x) => x.id === r![1]);
      if (!i) return send(404, { error: { code: "resource_missing" } });
      if (i.status !== "open") return send(400, { error: { code: "invoice_not_open" } });
      i.attempt_count = (i.attempt_count ?? 0) + 1;
      if (String(body.payment_method ?? "").includes("Declined")) return send(402, { error: { type: "card_error", code: "card_declined" } });
      i.status = "paid";
      i.amount_remaining = 0;
      return send(200, i);
    }
    if (req.method === "GET" && path === "/v1/payment_methods") {
      return send(200, { data: (S.paymentMethods ?? []).filter((p: any) => p.customer === q.get("customer")), has_more: false });
    }
    if (req.method === "GET" && (r = m(/^\/v1\/invoices\/([^/]+)$/))) {
      const i = S.invoices.find((x) => x.id === r![1]);
      return i ? send(200, i) : send(404, { error: { code: "resource_missing" } });
    }
    if (req.method === "GET" && path === "/v1/payment_intents") {
      return send(200, { data: S.paymentIntents.filter((p) => !q.get("customer") || p.customer === q.get("customer")), has_more: false });
    }
    if (req.method === "POST" && path === "/v1/payment_intents") {
      const declined = String(body.payment_method).includes("Declined");
      const p = { id: id("pi"), customer: body.customer, amount: Number(body.amount), amount_received: declined ? 0 : Number(body.amount), currency: body.currency, status: declined ? "requires_payment_method" : "succeeded", latest_charge: declined ? null : id("ch"), created: Math.floor(Date.now() / 1000), description: body.description, metadata: meta() };
      S.paymentIntents.push(p);
      return send(200, p);
    }
    if ((r = m(/^\/v1\/payment_intents\/([^/]+)$/))) {
      const p = S.paymentIntents.find((x) => x.id === r![1]);
      if (!p) return send(404, { error: { code: "resource_missing" } });
      if (req.method === "POST") p.metadata = { ...p.metadata, ...meta() };
      return send(200, p);
    }
    if (req.method === "POST" && path === "/v1/refunds") {
      const pi = S.paymentIntents.find((x) => x.id === body.payment_intent);
      if (!pi?.latest_charge) return send(400, { error: { code: "resource_missing", message: "No such charge" } });
      const done = S.refunds.filter((x) => x.payment_intent === pi.id).reduce((t, x) => t + x.amount, 0);
      if (done + Number(body.amount) > pi.amount_received) return send(400, { error: { code: "charge_already_refunded" } });
      const rf = { id: id("re"), amount: Number(body.amount), currency: pi.currency, charge: pi.latest_charge, payment_intent: pi.id, status: "succeeded", metadata: meta() };
      S.refunds.push(rf);
      return send(200, rf);
    }
    if (req.method === "GET" && path === "/v1/accounts") return send(200, { data: S.accounts, has_more: false });
    if (req.method === "POST" && (r = m(/^\/v1\/accounts\/([^/]+)$/))) {
      const a = S.accounts.find((x) => x.id === r![1]);
      if (!a) return send(404, { error: { code: "resource_missing" } });
      const interval = body["settings[payouts][schedule][interval]"];
      if (interval) a.settings = { ...a.settings, payouts: { schedule: { interval } } };
      a.metadata = { ...a.metadata, ...meta() };
      return send(200, a);
    }
    if (req.method === "GET" && (r = m(/^\/v1\/accounts\/([^/]+)$/))) {
      const a = S.accounts.find((x) => x.id === r![1]);
      return a ? send(200, a) : send(404, { error: { code: "resource_missing" } });
    }
    if (req.method === "POST" && path === "/v1/transfers") {
      const key = String(req.headers["idempotency-key"] ?? "");
      let t = key ? S.transferKeys.get(key) : undefined;
      if (!t) {
        t = { id: id("tr"), amount: Number(body.amount), currency: body.currency, destination: body.destination, transfer_group: body.transfer_group, metadata: meta(), reversed: false, amount_reversed: 0 };
        S.transfers.push(t);
        if (key) S.transferKeys.set(key, t);
      }
      if (S.loseTransferResponses > 0) {
        S.loseTransferResponses--;
        req.socket.destroy();
        return;
      }
      return send(200, t);
    }
    if (req.method === "GET" && path === "/v1/transfers") {
      return send(200, { data: S.transfers.filter((t) => !q.get("transfer_group") || t.transfer_group === q.get("transfer_group")), has_more: false });
    }
    if (req.method === "GET" && (r = m(/^\/v1\/transfers\/([^/]+)$/))) {
      const t = S.transfers.find((x) => x.id === r![1]);
      return t ? send(200, t) : send(404, { error: { code: "resource_missing" } });
    }
    if (req.method === "GET" && path === "/v1/payouts") {
      const gte = Number(q.get("arrival_date[gte]") ?? 0);
      const lt = Number(q.get("arrival_date[lt]") ?? Infinity);
      return send(200, { data: S.payouts.filter((p) => p.arrival_date >= gte && p.arrival_date < lt), has_more: false });
    }
    if (req.method === "GET" && path === "/v1/balance_transactions") {
      return send(200, { data: S.payoutTxns.filter((t) => t.payout === q.get("payout")), has_more: false });
    }
    if (req.method === "GET" && path === "/v1/disputes") return send(200, { data: S.disputes, has_more: false });
    if (req.method === "GET" && (r = m(/^\/v1\/refunds\/([^/]+)$/))) {
      const rf = S.refunds.find((x) => x.id === r![1]);
      return rf ? send(200, rf) : send(404, { error: { code: "resource_missing" } });
    }
    if (req.method === "GET" && (r = m(/^\/v1\/billing\/meters\/([^/]+)\/event_summaries$/))) {
      const [from, to] = [Number(q.get("start_time")), Number(q.get("end_time"))];
      const v = S.meterEvents.filter((e) => e.meter === r![1] && e.customer === q.get("customer") && e.ts >= from && e.ts < to).reduce((t, e) => t + e.value, 0);
      return send(200, { data: [{ id: id("mtrusg"), aggregated_value: v }], has_more: false });
    }
    if (req.method === "POST" && path === "/v1/invoices") {
      const key = String(req.headers["idempotency-key"] ?? "");
      if (key && S.keys.has(key)) return send(200, S.keys.get(key));
      const inv = { id: id("in"), customer: body.customer, status: "draft", amount_due: 0, amount_remaining: 0, currency: "usd", description: body.description, collection_method: body.collection_method, metadata: meta(), lines: { data: [] as any[] } };
      S.invoices.push(inv);
      if (key) S.keys.set(key, inv);
      return send(200, inv);
    }
    if (req.method === "POST" && path === "/v1/invoiceitems") {
      const key = String(req.headers["idempotency-key"] ?? "");
      if (key && S.keys.has(key)) return send(200, S.keys.get(key));
      const inv = S.invoices.find((i) => i.id === body.invoice);
      if (!inv || inv.status !== "draft") return send(400, { error: { code: "invoice_not_editable" } });
      const price = S.prices.find((p) => p.id === body.price);
      if (!price) return send(400, { error: { code: "resource_missing", param: "price" } });
      const item = { id: id("ii"), invoice: inv.id, customer: body.customer, price: price.id, quantity: Number(body.quantity), amount: price.unit_amount * Number(body.quantity), description: body.description };
      S.invoiceItems.push(item);
      inv.lines.data.push(item);
      inv.amount_due += item.amount;
      inv.amount_remaining += item.amount;
      if (key) S.keys.set(key, item);
      return send(200, item);
    }
    if (req.method === "POST" && (r = m(/^\/v1\/invoices\/([^/]+)\/(finalize|send)$/))) {
      const inv = S.invoices.find((i) => i.id === r![1]);
      if (!inv) return send(404, { error: { code: "resource_missing" } });
      if (r[2] === "finalize") {
        if (inv.status !== "draft") return send(400, { error: { code: "invoice_not_editable" } });
        inv.status = "open";
      } else {
        if (inv.status !== "open") return send(400, { error: { code: "invoice_not_open" } });
        inv.sent = true;
      }
      return send(200, inv);
    }
    if (req.method === "GET" && path === "/v1/invoices") {
      return send(200, { data: S.invoices.filter((i) => (!q.get("customer") || i.customer === q.get("customer")) && (!q.get("status") || i.status === q.get("status"))), has_more: false });
    }
    if (req.method === "GET" && path === "/v1/refunds") return send(200, { data: S.refunds, has_more: false });

    // ---- HubSpot
    const H = state.hubspot;
    if (req.method === "POST" && path === "/crm/v3/objects/contacts/search") {
      const filters: any[] = body.filterGroups?.[0]?.filters ?? [];
      const ok = (c: any, f: any) => {
        const v = c.properties[f.propertyName];
        if (f.operator === "HAS_PROPERTY") return v !== undefined && v !== null && v !== "";
        if (f.operator === "NOT_HAS_PROPERTY") return v === undefined || v === null || v === "";
        const eq = String(v ?? "").toLowerCase() === String(f.value).toLowerCase();
        return f.operator === "NEQ" ? !eq : eq;
      };
      const results = H.contacts.filter((c) => filters.every((f) => ok(c, f)));
      return send(200, { total: results.length, results });
    }
    if (req.method === "POST" && path === "/crm/v3/objects/contacts") {
      const existing = H.contacts.find((c) => c.properties.email === body.properties.email);
      if (existing) return send(409, { status: "error", category: "CONFLICT", message: `Contact already exists. Existing ID: ${existing.id}` });
      const c = { id: String(++seq), properties: { ...body.properties }, archived: false };
      H.contacts.push(c);
      return send(201, c);
    }
    if (req.method === "POST" && path === "/crm/v3/objects/contacts/gdpr-delete") {
      H.contacts = H.contacts.filter((c) => c.id !== String(body.objectId));
      return send(204, {});
    }
    if (req.method === "GET" && (r = m(/^\/communication-preferences\/v3\/status\/email\/([^/]+)$/))) {
      const email = decodeURIComponent(r[1]!);
      return send(200, { recipient: email, subscriptionStatuses: [...H.subscriptions].filter(([k]) => k.startsWith(`${email}|`)).map(([k, status]) => ({ id: k.split("|")[1], status })) });
    }
    if (req.method === "POST" && (r = m(/^\/communication-preferences\/v3\/(subscribe|unsubscribe)$/))) {
      const k = `${body.emailAddress}|${body.subscriptionId}`;
      const status = r[1] === "subscribe" ? "SUBSCRIBED" : "NOT_SUBSCRIBED";
      if (H.subscriptions.get(k) === status) return send(400, { status: "error", message: `${body.emailAddress} is already ${status.toLowerCase()}` });
      H.subscriptions.set(k, status);
      return send(200, { id: body.subscriptionId, status });
    }
    if ((r = m(/^\/crm\/v3\/objects\/contacts\/(\d+)$/))) {
      const c = H.contacts.find((x) => x.id === r![1]);
      if (!c) return send(404, { category: "OBJECT_NOT_FOUND" });
      if (req.method === "PATCH") Object.assign(c.properties, body.properties);
      return send(200, c);
    }

    // ---- Gmail
    if (req.method === "GET" && path === "/gmail/v1/users/me/messages") {
      const from = /from:(\S+)/.exec(q.get("q") ?? "")?.[1];
      const msgs = state.gmail.messages.filter((x) => !from || x.from === from);
      return send(200, { messages: msgs.map((_, i) => ({ id: `m${i}` })), resultSizeEstimate: msgs.length });
    }
    if (req.method === "POST" && path === "/gmail/v1/users/me/drafts") {
      const d = { id: id("draft"), message: body.message };
      state.gmail.drafts.push(d);
      return send(200, d);
    }

    // ---- Calendar
    if (req.method === "POST" && path === "/calendar/v3/freeBusy") {
      return send(200, { calendars: { [body.items[0].id]: { busy: state.calendar.busy } } });
    }
    if (req.method === "POST" && (r = m(/^\/calendar\/v3\/calendars\/([^/]+)\/events$/))) {
      const ev = { id: id("ev"), status: "confirmed", calendarId: r[1], sendUpdates: q.get("sendUpdates"), ...body };
      state.calendar.events.push(ev);
      return send(200, ev);
    }
    if (req.method === "GET" && (r = m(/^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/))) {
      const ev = state.calendar.events.find((e) => e.id === r![2]);
      return ev ? send(200, ev) : send(404, { error: { code: 404 } });
    }

    // ---- Slack
    if (req.method === "POST" && path === "/api/chat.postMessage") {
      // A user id is a direct message (Slack opens the DM).
      if (!state.slack.channels.has(body.channel) && !/^U[A-Z0-9_]+$/.test(body.channel)) return send(200, { ok: false, error: "channel_not_found" });
      const msg = { channel: body.channel, text: body.text, ts: `${Date.now()}.${++seq}`, ...(body.thread_ts ? { thread_ts: body.thread_ts } : {}) };
      state.slack.messages.push(msg);
      return send(200, { ok: true, channel: msg.channel, ts: msg.ts });
    }

    // ---- Shopify Admin
    if (req.method === "GET" && m(/^\/admin\/api\/[\w-]+\/orders\.json$/)) {
      const min = Date.parse(q.get("created_at_min") ?? "1970-01-01");
      const since = Number(q.get("since_id") ?? 0);
      const rows = state.shopify.orders.filter((o) => Date.parse(o.created_at ?? "1970-01-01") >= min && Number(o.id) > since).sort((a, b) => Number(a.id) - Number(b.id));
      return send(200, { orders: rows.slice(0, Number(q.get("limit") ?? 50)) });
    }
    if (req.method === "POST" && m(/^\/admin\/api\/[\w-]+\/draft_orders\.json$/)) {
      const d = { id: ++seq, ...body.draft_order, order_id: null as number | null };
      state.shopify.drafts.push(d);
      return send(201, { draft_order: d });
    }
    if (req.method === "PUT" && (r = m(/^\/admin\/api\/[\w-]+\/draft_orders\/(\d+)\/complete\.json$/))) {
      const d = state.shopify.drafts.find((x) => String(x.id) === r![1]);
      if (!d) return send(404, { errors: "Not Found" });
      if (!d.order_id) {
        d.order_id = ++seq;
        state.shopify.orders.push({ id: d.order_id, email: d.email, line_items: d.line_items, tags: d.tags, total_price: "0.00", created_at: new Date().toISOString() });
      }
      return send(200, { draft_order: d });
    }
    if (req.method === "GET" && (r = m(/^\/admin\/api\/[\w-]+\/variants\/(\d+)\.json$/))) {
      const v = state.shopify.variants.find((x) => String(x.id) === r![1]);
      return v ? send(200, { variant: v }) : send(404, { errors: "Not Found" });
    }
    if (req.method === "GET" && m(/^\/admin\/api\/[\w-]+\/inventory_levels\.json$/)) {
      const ids = (q.get("inventory_item_ids") ?? "").split(",");
      return send(200, { inventory_levels: state.shopify.levels.filter((l) => ids.includes(String(l.inventory_item_id)) && String(l.location_id) === q.get("location_ids")) });
    }
    if ((r = m(/^\/admin\/api\/[\w-]+\/orders\/([^/]+)\.json$/))) {
      const o = state.shopify.orders.find((x) => String(x.id) === r![1]);
      if (!o) return send(404, { errors: "Not Found" });
      if (req.method === "PUT") Object.assign(o, body.order, { id: o.id });
      return send(200, { order: o });
    }
    if ((r = m(/^\/admin\/api\/[\w-]+\/orders\/([^/]+)\/fulfillments\.json$/))) {
      // The order-based create was removed in 2022-07; only the list remains.
      if (req.method !== "GET") return send(404, { errors: "Not Found" });
      return send(200, { fulfillments: state.shopify.fulfillments.filter((f) => String(f.order_id) === r![1]) });
    }
    if (req.method === "GET" && (r = m(/^\/admin\/api\/[\w-]+\/orders\/([^/]+)\/fulfillment_orders\.json$/))) {
      const o = state.shopify.orders.find((x) => String(x.id) === r![1]);
      if (!o) return send(404, { errors: "Not Found" });
      const done = state.shopify.fulfillments.some((f) => String(f.order_id) === r![1]);
      return send(200, { fulfillment_orders: [{ id: Number(`9${o.id}`), order_id: o.id, status: o.cancelled_at ? "cancelled" : done ? "closed" : "open" }] });
    }
    if (req.method === "POST" && m(/^\/admin\/api\/[\w-]+\/fulfillments\.json$/)) {
      const foId = String(body.fulfillment?.line_items_by_fulfillment_order?.[0]?.fulfillment_order_id ?? "");
      const o = state.shopify.orders.find((x) => `9${x.id}` === foId);
      if (!o) return send(422, { errors: { fulfillment_order_id: ["is invalid"] } });
      const t = body.fulfillment.tracking_info ?? {};
      const f = { id: ++seq, order_id: String(o.id), status: "success", tracking_number: t.number, tracking_company: t.company, tracking_url: t.url, notify_customer: body.fulfillment.notify_customer };
      state.shopify.fulfillments.push(f);
      return send(201, { fulfillment: f });
    }

    // ---- NetSuite
    if (req.method === "GET" && (r = m(/^\/services\/rest\/record\/v1\/(salesOrder|purchaseOrder)\/eid:(.+)$/))) {
      const list = r[1] === "salesOrder" ? state.netsuite.salesOrders : state.netsuite.purchaseOrders;
      const rec = list.find((x) => x.externalId === decodeURIComponent(r![2]!));
      return rec ? send(200, rec) : send(404, { title: "Record not found" });
    }
    if (req.method === "POST" && path === "/services/rest/query/v1/suiteql" && /FROM customer WHERE email/.test(body.q)) {
      const email = /email = '([^']*)'/.exec(body.q)?.[1];
      return send(200, { items: state.netsuite.customers.filter((c) => c.email === email).map((c) => ({ id: c.id })), hasMore: false });
    }
    if (path === "/services/rest/record/v1/salesOrder") {
      const N = state.netsuite;
      if (req.method === "POST") {
        if (!body.entity?.id) return send(400, { title: "Invalid reference", "o:errorDetails": [{ detail: "entity must reference a record by id" }] });
        const so = { id: String(++seq), tranId: `SO${seq}`, externalId: body.externalId, entity: body.entity, item: body.item };
        N.salesOrders.push(so);
        res.writeHead(204, { location: `/services/rest/record/v1/salesOrder/${so.id}` });
        return res.end();
      }
      const ext = /externalId IS "([^"]+)"/.exec(q.get("q") ?? "")?.[1];
      return send(200, { items: N.salesOrders.filter((x) => !ext || x.externalId === ext).map((x) => ({ id: x.id })) });
    }
    if (path === "/services/rest/record/v1/purchaseOrder") {
      const P = state.netsuite.purchaseOrders;
      if (req.method === "POST") {
        const po = { id: String(++seq), tranId: `PO${seq}`, ...body, total: (body.expense?.items ?? []).reduce((t: number, l: any) => t + l.amount, 0) };
        P.push(po);
        res.writeHead(204, { location: `/services/rest/record/v1/purchaseOrder/${po.id}` });
        return res.end();
      }
      const ext = /externalId IS "([^"]+)"/.exec(q.get("q") ?? "")?.[1];
      return send(200, { items: P.filter((x) => !ext || x.externalId === ext).map((x) => ({ id: x.id, tranId: x.tranId })) });
    }
    if (req.method === "POST" && path === "/services/rest/query/v1/suiteql" && /JOIN transactionline/.test(body.q)) {
      const open: Record<string, number> = {};
      for (const p of state.netsuite.purchaseOrders.filter((x) => x.status !== "closed")) for (const l of p.item?.items ?? []) open[l.item.id] = (open[l.item.id] ?? 0) + l.quantity - (l.quantityReceived ?? 0);
      return send(200, { items: Object.entries(open).map(([item, n]) => ({ item, open: n })) });
    }
    if (req.method === "POST" && path === "/services/rest/query/v1/suiteql" && /type = 'PurchOrd'/.test(body.q)) {
      const entity = /entity = (\d+)/.exec(body.q)?.[1];
      const dept = /department = (\d+)/.exec(body.q)?.[1];
      const total = /foreigntotal = ([\d.]+)/.exec(body.q)?.[1];
      const rows = state.netsuite.purchaseOrders.filter((p) => (!entity || p.entity?.id === entity) && (!dept || p.department?.id === dept) && (!total || p.total === Number(total)));
      return send(200, { items: /SUM\(/.test(body.q) ? [{ amount: rows.reduce((t, p) => t + (p.total ?? 0), 0) }] : rows.map((p) => ({ id: p.id, tranid: p.tranId })) });
    }
    if ((r = m(/^\/services\/rest\/record\/v1\/(vendorBill|purchaseOrder)\/([^/]+)$/))) {
      const list = r[1] === "vendorBill" ? state.netsuite.vendorBills : state.netsuite.purchaseOrders;
      const rec = list.find((x) => x.id === r![2]);
      if (!rec) return send(404, { title: "Record not found" });
      if (req.method === "PATCH") {
        Object.assign(rec, body);
        res.writeHead(204);
        return res.end();
      }
      return send(200, rec);
    }
    if ((r = m(/^\/services\/rest\/record\/v1\/vendor\/([^/]+)$/))) {
      const v = state.netsuite.vendors.find((x) => x.id === r![1]);
      if (!v) return send(404, { title: "Record not found" });
      if (req.method === "PATCH") {
        Object.assign(v, body);
        res.writeHead(204);
        return res.end();
      }
      return send(200, v);
    }
    if (req.method === "POST" && path === "/services/rest/query/v1/suiteql" && /type = 'Journal'/.test(body.q)) {
      const ext = /externalid = '([^']*)'/.exec(body.q)?.[1];
      return send(200, { items: state.netsuite.journals.filter((j) => j.externalId === ext).map((j) => ({ id: j.id })) });
    }
    if (req.method === "POST" && path === "/services/rest/query/v1/suiteql" && /FROM accountingperiod/.test(body.q)) {
      const name = /periodname = '([^']*)'/.exec(body.q)?.[1];
      return send(200, { items: state.netsuite.periods.filter((x) => x.periodName === name).map((x) => ({ id: x.id })) });
    }
    if (req.method === "POST" && path === "/services/rest/query/v1/suiteql" && /isbilled = 'F'/.test(body.q)) {
      return send(200, { items: [{ amount: state.netsuite.unbilledReceipts }] });
    }
    if (req.method === "POST" && path === "/services/rest/record/v1/journalEntry") {
      const j = { id: String(++seq), ...body };
      state.netsuite.journals.push(j);
      res.writeHead(204, { location: `/services/rest/record/v1/journalEntry/${j.id}` });
      return res.end();
    }
    if (req.method === "PATCH" && (r = m(/^\/services\/rest\/record\/v1\/accountingPeriod\/([^/]+)$/))) {
      const per = state.netsuite.periods.find((x) => x.id === r![1]);
      if (!per) return send(404, {});
      Object.assign(per, body);
      res.writeHead(204);
      return res.end();
    }
    if (req.method === "POST" && path === "/services/rest/query/v1/suiteql" && /approvalstatus = 1/.test(body.q)) {
      return send(200, { items: state.netsuite.vendorBills.filter((b) => b.approvalStatus?.id === "1").map((b) => ({ id: b.id })) });
    }
    if (req.method === "POST" && path === "/services/rest/query/v1/suiteql" && /id <> (\d+)/.test(body.q)) {
      const [, entity] = /entity = (\d+)/.exec(body.q)!;
      const [, self] = /id <> (\d+)/.exec(body.q)!;
      const tranid = /tranid = '([^']*)'/.exec(body.q)?.[1];
      const total = Number(/foreigntotal = ([\d.]+)/.exec(body.q)?.[1]);
      const since = /TO_DATE\('([\d-]+)'/.exec(body.q)?.[1] ?? "";
      const dup = state.netsuite.vendorBills.filter((b) => b.entity?.id === entity && b.id !== self && (b.tranId === tranid || (b.total === total && b.tranDate >= since)));
      return send(200, { items: dup.map((b) => ({ id: b.id })) });
    }
    if (req.method === "POST" && path === "/services/rest/query/v1/suiteql") {
      const entity = /entity = (\d+)/.exec(body.q)?.[1];
      const until = /TO_DATE\('([\d-]+)'/.exec(body.q)?.[1];
      return send(200, { items: state.netsuite.bills.filter((b) => (!entity || b.entity === entity) && b.status === "open" && (!until || b.duedate <= until)).map((b) => ({ amount: b.amount })) });
    }
    if (req.method === "GET" && (r = m(/^\/services\/rest\/record\/v1\/salesOrder\/([^/]+)$/))) {
      const so = state.netsuite.salesOrders.find((x) => x.id === r![1]);
      return so ? send(200, so) : send(404, { title: "Not Found" });
    }

    // ---- EasyPost
    if (req.method === "POST" && path === "/shipments") {
      const sh = { id: id("shp"), reference: body.shipment.reference, to: body.shipment.to_address, rates: state.easypost.rates.map((x: any, i: number) => ({ id: `rate_${seq}_${i}`, ...x })), tracking_code: null as string | null, keys: [] as string[] };
      state.easypost.shipments.push(sh);
      return send(201, sh);
    }
    if (req.method === "POST" && (r = m(/^\/shipments\/([^/]+)\/buy$/))) {
      const sh = state.easypost.shipments.find((x) => x.id === r![1]);
      if (!sh) return send(404, { error: { code: "NOT_FOUND" } });
      if (sh.tracking_code) return send(422, { error: { code: "SHIPMENT.POSTAGE.EXISTS" } });
      const rate = sh.rates.find((x: any) => x.id === body.rate.id);
      sh.tracking_code = `9400${seq}`;
      sh.selected_rate = rate;
      return send(200, sh);
    }
    if (req.method === "GET" && (r = m(/^\/shipments\/([^/]+)$/))) {
      const sh = state.easypost.shipments.find((x) => x.id === r![1]);
      return sh ? send(200, sh) : send(404, { error: { code: "NOT_FOUND" } });
    }

    // ---- Gusto
    if ((r = m(/^\/v1\/employees\/([^/]+)\/terminations$/))) {
      const G = state.gusto;
      if (req.method === "POST") {
        const t = { uuid: id("term"), employee_uuid: r[1], effective_date: body.effective_date, active: true };
        G.terminations.push(t);
        return send(201, t);
      }
      if (req.method === "DELETE") {
        const t = G.terminations.find((x) => x.employee_uuid === r![1] && x.active);
        if (!t) return send(404, { errors: [{ category: "not_found" }] });
        t.active = false;
        res.writeHead(204);
        return res.end();
      }
      return send(200, G.terminations.filter((x) => x.employee_uuid === r![1] && x.active));
    }
    if ((r = m(/^\/v1\/companies\/([^/]+)\/payrolls$/))) {
      if (req.method === "POST") {
        const p = { uuid: id("payroll"), off_cycle: true, off_cycle_reason: body.off_cycle_reason, check_date: body.check_date, processed: false, employee_compensations: (body.employee_uuids ?? []).map((u: string) => ({ employee_uuid: u })) };
        state.gusto.payrolls.push(p);
        return send(201, p);
      }
      return send(200, state.gusto.payrolls);
    }
    if (req.method === "GET" && (r = m(/^\/v1\/companies\/([^/]+)\/employees$/))) return send(200, state.gusto.employees);
    if (req.method === "PUT" && (r = m(/^\/v1\/companies\/([^/]+)\/payrolls\/([^/]+)\/(calculate|prepare)$/))) {
      const p = state.gusto.payrolls.find((x) => x.uuid === r![2]);
      if (!p) return send(404, {});
      if (r[3] === "calculate") {
        p.calculated_at = new Date().toISOString();
        return send(202, {});
      }
      p.version ??= `v${++seq}`;
      return send(200, p);
    }
    if ((r = m(/^\/v1\/companies\/([^/]+)\/payrolls\/([^/]+)$/))) {
      const p = state.gusto.payrolls.find((x) => x.uuid === r![2]);
      if (!p) return send(404, { errors: [{ category: "not_found" }] });
      if (req.method === "PUT") {
        if (p.processed) return send(422, { errors: [{ category: "invalid_operation", message: "Payroll already processed" }] });
        if (body.version !== p.version) return send(409, { errors: [{ category: "invalid_attribute_value", error_key: "version" }] });
        for (const c of body.employee_compensations ?? []) {
          const cur = p.employee_compensations.find((x: any) => x.employee_uuid === c.employee_uuid);
          if (cur) cur.excluded = c.excluded;
        }
        p.version = `v${++seq}`;
      }
      return send(200, p);
    }
    if (req.method === "PUT" && (r = m(/^\/v1\/companies\/([^/]+)\/payrolls\/([^/]+)\/submit$/))) {
      const p = state.gusto.payrolls.find((x) => x.uuid === r![2]);
      if (!p) return send(404, {});
      p.processed = true;
      return send(202, p);
    }

    // ---- Box
    if (req.method === "POST" && path === "/files/content") {
      const attrs = JSON.parse(/name="attributes"\r\n\r\n(.*?)\r\n--/s.exec(raw)![1]!);
      const content = /name="file"; filename="[^"]*"\r\nContent-Type: [^\r]*\r\n\r\n(.*?)\r\n--/s.exec(raw)![1]!;
      if (state.box.files.some((f) => f.folder === attrs.parent.id && f.name === attrs.name)) return send(409, { type: "error", code: "item_name_in_use" });
      const f = { id: String(9_000_000 + ++seq), name: attrs.name, text: null, folder: attrs.parent.id, content };
      state.box.files.push(f);
      return send(201, { total_count: 1, entries: [{ type: "file", id: f.id, name: f.name }] });
    }
    if (req.method === "GET" && path === "/search") {
      const folder = q.get("ancestor_folder_ids");
      return send(200, { entries: state.box.files.filter((f) => f.name.includes(q.get("query") ?? "") && (!folder || f.folder === folder)).map((f) => ({ type: "file", id: f.id, name: f.name })) });
    }
    if (req.method === "PUT" && (r = m(/^\/files\/(\d+)$/))) {
      const f = state.box.files.find((x) => x.id === r![1]);
      if (!f) return send(404, { type: "error", code: "not_found" });
      f.sharedLink = { url: `https://acme.app.box.com/s/${f.id}x`, unshared_at: body.shared_link.unshared_at };
      return send(200, { id: f.id, shared_link: f.sharedLink });
    }
    if (req.method === "GET" && (r = m(/^\/files\/(\d+)$/))) {
      const f = state.box.files.find((x) => x.id === r![1]);
      if (!f) return send(404, { type: "error", code: "not_found" });
      if ((q.get("fields") ?? "").includes("representations")) {
        return send(200, { id: f.id, representations: { entries: f.text === null ? [] : [{ representation: "extracted_text", status: { state: "success" }, content: { url_template: `${base}/internal_files/${f.id}/versions/1/representations/extracted_text/content/{+asset_path}` } }] } });
      }
      return send(200, { id: f.id, name: f.name, extension: "pdf" });
    }
    if (req.method === "GET" && (r = m(/^\/internal_files\/(\d+)\/versions\/1\/representations\/extracted_text\/content\/$/))) {
      const f = state.box.files.find((x) => x.id === r![1]);
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(f?.text ?? "");
    }
    if (req.method === "GET" && (r = m(/^\/files\/(\d+)\/content$/))) {
      res.writeHead(200, { "content-type": "application/pdf" });
      return res.end("%PDF-1.4 fake");
    }

    // ---- Notion
    if ((r = m(/^\/v1\/pages\/([^/]+)$/))) {
      const pg = state.notion.pages.find((x) => x.id === r![1]);
      if (!pg) return send(404, { object: "error", code: "object_not_found" });
      if (req.method === "PATCH") {
        Object.assign(pg.properties, body.properties);
        pg.last_edited_time = new Date(Date.now() + ++seq).toISOString();
      }
      return send(200, pg);
    }

    // ---- EasyPost trackers
    if (req.method === "GET" && (r = m(/^\/trackers\/([^/]+)$/))) {
      const t = state.easypost.trackers.find((x) => x.id === r![1]);
      return t ? send(200, t) : send(404, { error: { code: "NOT_FOUND" } });
    }

    // ---- DocuSign
    if ((r = m(/^\/v2\.1\/accounts\/([^/]+)\/envelopes$/))) {
      if (req.method === "POST") {
        const ext = body.customFields?.textCustomFields?.find((f: any) => f.name === "acme_external_id")?.value;
        const env = { envelopeId: id("env"), status: "sent", externalId: ext, signers: body.recipients.signers, reminders: 0 };
        state.docusign.envelopes.push(env);
        return send(201, { envelopeId: env.envelopeId, status: "sent" });
      }
      const cf = (q.get("custom_field") ?? "").split("=")[1];
      return send(200, { envelopes: state.docusign.envelopes.filter((e) => !cf || e.externalId === cf) });
    }
    if ((r = m(/^\/v2\.1\/accounts\/([^/]+)\/envelopes\/([^/]+)(\/recipients)?$/))) {
      const env = state.docusign.envelopes.find((e) => e.envelopeId === r![2]);
      if (!env) return send(404, { errorCode: "ENVELOPE_DOES_NOT_EXIST" });
      if (req.method === "PUT" && r[3]) env.reminders++;
      else if (req.method === "PUT") Object.assign(env, { status: body.status, voidedReason: body.voidedReason });
      return send(200, env);
    }

    // ---- GitHub Dependabot alerts and issues
    if (req.method === "GET" && (r = m(/^\/repos\/([^/]+\/[^/]+)\/dependabot\/alerts$/))) {
      const page = Number(q.get("page") ?? 1);
      const rows = state.dependabot.filter((a) => a.repo === r![1] && (!q.get("state") || a.state === q.get("state")));
      return send(200, rows.slice((page - 1) * 100, page * 100));
    }
    if ((r = m(/^\/repos\/([^/]+\/[^/]+)\/dependabot\/alerts\/(\d+)$/))) {
      const a = state.dependabot.find((x) => x.repo === r![1] && String(x.number) === r![2]);
      if (!a) return send(404, { message: "Not Found" });
      if (req.method === "PATCH") Object.assign(a, { state: body.state, dismissed_reason: body.dismissed_reason });
      return send(200, a);
    }
    if ((r = m(/^\/repos\/([^/]+\/[^/]+)\/issues$/))) {
      if (req.method === "POST") {
        const i = { repo: r[1]!, number: state.issues.filter((x) => x.repo === r![1]).length + 1, title: body.title, body: body.body, state: "open", labels: body.labels ?? [], comments: [] as string[] };
        state.issues.push(i);
        return send(201, { ...i, labels: i.labels.map((name: string) => ({ name })) });
      }
      const want = (q.get("labels") ?? "").split(",").filter(Boolean);
      return send(200, state.issues.filter((i) => i.repo === r![1] && want.every((l) => i.labels.includes(l))).map((i) => ({ ...i, labels: i.labels.map((name) => ({ name })) })));
    }
    if (req.method === "POST" && (r = m(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/(comments|labels)$/))) {
      const i = state.issues.find((x) => x.repo === r![1] && String(x.number) === r![2]);
      if (!i) return send(404, { message: "Not Found" });
      if (r[3] === "comments") i.comments.push(body.body);
      else i.labels.push(...body.labels.filter((l: string) => !i.labels.includes(l)));
      return send(201, { id: ++seq });
    }

    // ---- GitHub pulls, checks, deployments
    if (req.method === "GET" && (r = m(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/))) {
      const pr = state.gh.pulls.find((x) => x.repo === r![1] && String(x.number) === r![2]);
      return pr ? send(200, pr) : send(404, { message: "Not Found" });
    }
    if (req.method === "GET" && (r = m(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews$/))) {
      return send(200, state.gh.reviews.filter((x) => x.repo === r![1] && String(x.number) === r![2]));
    }
    if (req.method === "GET" && (r = m(/^\/repos\/([^/]+\/[^/]+)\/commits\/([^/]+)\/check-runs$/))) {
      return send(200, { total_count: 0, check_runs: state.gh.checkRuns.filter((x) => x.repo === r![1] && x.sha === r![2]) });
    }
    if ((r = m(/^\/repos\/([^/]+\/[^/]+)\/deployments$/))) {
      if (req.method === "POST") {
        const d = { id: ++seq, repo: r[1], sha: body.ref, ref: body.ref, environment: body.environment, description: body.description, payload: body.payload ?? {}, created_at: new Date().toISOString() };
        state.gh.deployments.unshift(d);
        return send(201, d);
      }
      return send(200, state.gh.deployments.filter((x) => x.repo === r![1] && (!q.get("environment") || x.environment === q.get("environment"))));
    }
    if (req.method === "POST" && (r = m(/^\/repos\/([^/]+\/[^/]+)\/deployments\/(\d+)\/statuses$/))) {
      const st = { id: ++seq, deployment_id: Number(r[2]), state: body.state, description: body.description };
      state.gh.statuses.push(st);
      return send(201, st);
    }

    // ---- Modern Treasury
    const MT = state.moderntreasury;
    if (req.method === "GET" && (r = m(/^\/api\/external_accounts\/([^/]+)$/))) {
      const a = MT.externalAccounts.find((x) => x.id === r![1]);
      return a ? send(200, a) : send(404, { errors: { code: "resource_not_found" } });
    }
    if (req.method === "GET" && (r = m(/^\/api\/counterparties\/([^/]+)$/))) {
      const c = MT.counterparties.find((x) => x.id === r![1]);
      return c ? send(200, c) : send(404, { errors: { code: "resource_not_found" } });
    }
    if (req.method === "GET" && path === "/api/payment_orders") {
      const meta = q.get("metadata[acme_payment_id]");
      const rows = MT.orders.filter((o) => (!q.get("receiving_account_id") || o.receiving_account_id === q.get("receiving_account_id")) && (!q.get("originating_account_id") || o.originating_account_id === q.get("originating_account_id")) && (!meta || o.metadata?.acme_payment_id === meta));
      return send(200, rows);
    }
    if (req.method === "POST" && path === "/api/payment_orders") {
      const key = String(req.headers["idempotency-key"] ?? "");
      if (key && MT.keys.has(key)) return send(201, MT.keys.get(key));
      const o = { id: id("po"), status: "approved", created_at: new Date().toISOString(), ...body };
      MT.orders.push(o);
      if (key) MT.keys.set(key, o);
      return send(201, o);
    }
    if (req.method === "GET" && (r = m(/^\/api\/payment_orders\/([^/]+)$/))) {
      const o = MT.orders.find((x) => x.id === r![1]);
      return o ? send(200, o) : send(404, { errors: { code: "resource_not_found" } });
    }

    // ---- PagerDuty
    if (req.method === "GET" && path === "/incidents") {
      return send(200, { incidents: state.pagerduty.incidents.filter((i) => i.status !== "resolved"), more: false });
    }
    if (req.method === "POST" && path === "/incidents") {
      const inc = body.incident;
      if (state.pagerduty.incidents.some((i) => i.incident_key === inc.incident_key && i.status !== "resolved")) return send(400, { error: { message: "Open incident with matching dedup key already exists on this service", code: 2001 } });
      const created = { id: id("PINC"), status: "triggered", urgency: inc.urgency, title: inc.title, incident_key: inc.incident_key, service: inc.service, from: req.headers.from };
      state.pagerduty.incidents.push(created);
      return send(201, { incident: created });
    }

    // ---- Datadog
    if (req.method === "GET" && (r = m(/^\/api\/v1\/monitor\/(\d+)$/))) {
      const mon = state.datadog.monitors.find((x) => String(x.id) === r![1]);
      return mon ? send(200, mon) : send(404, { errors: ["Monitor not found"] });
    }
    if (req.method === "GET" && path === "/api/v1/query") {
      return send(200, { status: "ok", series: [{ pointlist: [[Date.now(), state.datadog.errorRate]] }] });
    }

    // ---- GitHub organizations
    if (req.method === "GET" && (r = m(/^\/orgs\/([^/]+)\/members$/))) {
      const page = Number(q.get("page") ?? 1);
      const per = Number(q.get("per_page") ?? 30);
      const rows = state.github.members.filter((x) => x.org === r![1] && (!q.get("role") || q.get("role") === "all" || x.role === q.get("role")));
      return send(200, rows.slice((page - 1) * per, page * per).map(({ login, id }) => ({ login, id })));
    }
    if ((r = m(/^\/orgs\/([^/]+)\/memberships\/([^/]+)$/))) {
      const mem = state.github.members.find((x) => x.org === r![1] && x.login === r![2]);
      if (!mem) return send(404, { message: "Not Found" });
      if (req.method === "DELETE") {
        state.github.members = state.github.members.filter((x) => x !== mem);
        res.writeHead(204);
        return res.end();
      }
      return send(200, { role: mem.role, state: "active" });
    }

    // ---- Plaid
    if (req.method === "POST" && path === "/identity/match") {
      const accts = state.plaid.accounts[body.access_token];
      if (!accts) return send(400, { error_type: "INVALID_INPUT", error_code: "INVALID_ACCESS_TOKEN" });
      return send(200, { accounts: accts });
    }

    if (req.method === "POST" && path === "/transactions/get") {
      const all = (state.plaid.transactions[body.access_token] ?? []).filter((t) => t.date >= body.start_date && t.date <= body.end_date);
      const off = body.options?.offset ?? 0;
      const count = body.options?.count ?? 100;
      return send(200, { transactions: all.slice(off, off + count), total_transactions: all.length });
    }

    // ---- Twilio Verify
    if (req.method === "POST" && (r = m(/^\/v2\/Services\/([^/]+)\/Verifications$/))) {
      const v = { sid: id("VE"), to: body.To, channel: body.Channel, status: "pending" };
      state.verify.verifications.push(v);
      return send(201, v);
    }

    // ---- Trade.gov Consolidated Screening List
    if (req.method === "GET" && path === "/consolidated_screening_list/v1/search") {
      const name = (q.get("name") ?? "").toLowerCase();
      return send(200, { results: state.screening.entries.filter((e) => name && e.name.toLowerCase().includes(name)) });
    }

    // ---- OpenAI
    if (req.method === "POST" && path === "/chat/completions") {
      state.openai.calls.push(body);
      const r = state.openai.replies.shift() ?? { content: JSON.stringify({ category: "how_to", priority: "normal", summary: "Asks how to export a report", reply: "Hello! You can export reports from Settings > Exports; see https://docs.acme.example/exports.", confidence: 0.92 }) };
      return send(200, { id: id("chatcmpl"), object: "chat.completion", model: body.model, choices: [{ index: 0, finish_reason: "stop", message: { role: r.role ?? "assistant", content: r.content } }] });
    }

    // ---- Zendesk
    const Z = state.zendesk;
    if (req.method === "POST" && path === "/api/v2/tickets.json") {
      const u = body.ticket;
      const t = { id: ++seq, subject: u.subject, status: "new", tags: u.tags ?? [], external_id: u.external_id, requester_id: ++seq, requester_email: u.requester?.email, updated_at: new Date().toISOString() };
      Z.tickets.push(t);
      if (u.comment) Z.comments.push({ id: ++seq, ticketId: t.id, author_id: t.requester_id, ...u.comment });
      return send(201, { ticket: t });
    }
    if (req.method === "GET" && path === "/api/v2/tickets.json") {
      if (q.get("page[size]")) {
        const size = Number(q.get("page[size]"));
        const start = Number(q.get("page[after]") ?? 0);
        const page = Z.tickets.slice(start, start + size);
        const more = start + size < Z.tickets.length;
        return send(200, { tickets: page, meta: { has_more: more, after_cursor: more ? String(start + size) : null } });
      }
      return send(200, { tickets: Z.tickets.filter((t) => !q.get("external_id") || t.external_id === q.get("external_id")) });
    }
    if (req.method === "GET" && (r = m(/^\/api\/v2\/tickets\/(\d+)\/comments\.json$/))) {
      return send(200, { comments: Z.comments.filter((c) => String(c.ticketId) === r![1]) });
    }
    if ((r = m(/^\/api\/v2\/tickets\/(\d+)\.json$/))) {
      const t = Z.tickets.find((x) => String(x.id) === r![1]);
      if (!t) return send(404, { error: "RecordNotFound" });
      if (req.method === "PUT") {
        const u = body.ticket;
        if (u.safe_update && u.updated_stamp !== t.updated_at) return send(409, { error: "UpdateConflict" });
        if (u.priority) t.priority = u.priority;
        if (u.additional_tags) t.tags = [...new Set([...(t.tags ?? []), ...u.additional_tags])];
        if (u.tags) t.tags = u.tags;
        if (u.status) t.status = u.status;
        if (u.comment) Z.comments.push({ id: ++seq, ticketId: t.id, author_id: 9001, ...u.comment });
        t.updated_at = new Date(Date.now() + ++seq).toISOString();
      }
      return send(200, { ticket: t });
    }
    if (req.method === "GET" && (r = m(/^\/api\/v2\/users\/(\d+)\.json$/))) {
      const u = Z.users.find((x) => String(x.id) === r![1]) ?? Z.tickets.filter((t) => String(t.requester_id) === r![1]).map((t) => ({ id: t.requester_id, email: t.requester_email, name: t.requester_name }))[0];
      return u ? send(200, { user: u }) : send(404, { error: "RecordNotFound" });
    }
    if (req.method === "GET" && path === "/api/v2/search.json") {
      const query = q.get("query") ?? "";
      const tag = /tags:(\S+)/.exec(query)?.[1];
      const requester = /requester:(\S+)/.exec(query)?.[1];
      const results = Z.tickets.filter((t) => (!tag || t.tags?.includes(tag)) && (!requester || t.requester_email === requester));
      return send(200, { results, next_page: null });
    }
    if (req.method === "POST" && path === "/api/v2/organizations/create_or_update.json") {
      let o = Z.orgs.find((x) => x.external_id === body.organization.external_id);
      if (!o) Z.orgs.push((o = { id: ++seq, ...body.organization }));
      return send(200, { organization: o });
    }
    if (req.method === "POST" && path === "/api/v2/users/create_or_update.json") {
      let u = Z.users.find((x) => x.email === body.user.email);
      if (!u) Z.users.push((u = { id: ++seq, ...body.user }));
      else Object.assign(u, body.user);
      return send(200, { user: u });
    }

    // ---- WorkOS
    const W = state.workos;
    if (req.method === "GET" && path === "/user_management/users") {
      return send(200, { data: W.users.filter((u) => !q.get("email") || u.email === q.get("email")), list_metadata: {} });
    }
    if (req.method === "POST" && path === "/user_management/users") {
      const u = { id: id("user"), ...body };
      W.users.push(u);
      return send(201, u);
    }
    if (req.method === "POST" && path === "/user_management/organization_memberships") {
      const mem = { id: id("om"), user_id: body.user_id, organization_id: body.organization_id, role: { slug: body.role_slug }, status: "active" };
      W.memberships.push(mem);
      return send(201, mem);
    }
    if ((r = m(/^\/user_management\/organization_memberships\/([^/]+)$/))) {
      const mem = W.memberships.find((x) => x.id === r![1]);
      if (!mem) return send(404, { code: "entity_not_found" });
      if (req.method === "DELETE") {
        W.memberships = W.memberships.filter((x) => x.id !== mem.id);
        return send(204, {});
      }
      return send(200, mem);
    }
    if (req.method === "GET" && (r = m(/^\/user_management\/users\/([^/]+)\/sessions$/))) {
      return send(200, { data: W.sessions.filter((x) => x.user_id === r![1] && !x.revoked), list_metadata: {} });
    }
    if (req.method === "POST" && path === "/user_management/sessions/revoke") {
      const ses = W.sessions.find((x) => x.id === body.session_id);
      if (!ses) return send(404, { code: "entity_not_found" });
      ses.revoked = true;
      return send(200, {});
    }
    if ((r = m(/^\/user_management\/users\/([^/]+)$/))) {
      const u = W.users.find((x) => x.id === r![1]);
      if (!u) return send(404, { code: "entity_not_found" });
      if (req.method === "DELETE") {
        W.users = W.users.filter((x) => x.id !== u.id);
        W.memberships = W.memberships.filter((x) => x.user_id !== u.id);
        return send(204, {});
      }
      return send(200, u);
    }
    if (req.method === "GET" && path === "/user_management/organization_memberships") {
      const org = q.get("organization_id");
      return send(200, { data: W.memberships.filter((x) => (org ? x.organization_id === org : x.user_id === q.get("user_id"))), list_metadata: {} });
    }

    // ---- Asana
    if (req.method === "POST" && path === "/tasks") {
      const t = { gid: String(++seq), ...body.data };
      state.asana.tasks.push(t);
      return send(201, { data: t });
    }
    if (req.method === "POST" && (r = m(/^\/tasks\/(\d+)\/stories$/))) {
      const st = { gid: String(++seq), task: r[1]!, text: body.data.text };
      state.asana.stories.push(st);
      return send(201, { data: st });
    }
    if (req.method === "GET" && (r = m(/^\/tasks\/(\d+)$/))) {
      const t = state.asana.tasks.find((x) => x.gid === r![1]);
      return t ? send(200, { data: t }) : send(404, { errors: [{ message: "Not found" }] });
    }

    // ---- Square
    const Q = state.square;
    if (req.method === "GET" && (r = m(/^\/v2\/locations\/([^/]+)$/))) {
      const l = Q.locations.find((x) => x.id === r![1]);
      return l ? send(200, { location: l }) : send(404, { errors: [{ code: "NOT_FOUND" }] });
    }
    if (req.method === "POST" && path === "/v2/gift-cards") {
      let g = Q.giftCards.find((x) => x.idempotency_key === body.idempotency_key);
      if (!g) Q.giftCards.push((g = { id: id("gftc"), type: "DIGITAL", state: "PENDING", gan: `7783${String(++seq).padStart(12, "0")}`, idempotency_key: body.idempotency_key, location_id: body.location_id }));
      return send(200, { gift_card: g });
    }
    if (req.method === "POST" && path === "/v2/gift-cards/activities") {
      const a = body.gift_card_activity;
      const g = Q.giftCards.find((x) => x.id === a.gift_card_id);
      if (!g) return send(404, { errors: [{ code: "NOT_FOUND" }] });
      let act = Q.activities.find((x) => x.idempotency_key === body.idempotency_key);
      if (!act) {
        g.state = "ACTIVE";
        g.balance_money = a.activate_activity_details.amount_money;
        Q.activities.push((act = { id: id("gcact"), type: a.type, gift_card_id: g.id, idempotency_key: body.idempotency_key, gift_card_balance_money: g.balance_money }));
      }
      return send(200, { gift_card_activity: act });
    }
    if (req.method === "GET" && (r = m(/^\/v2\/gift-cards\/([^/]+)$/))) {
      const g = Q.giftCards.find((x) => x.id === r![1]);
      return g ? send(200, { gift_card: g }) : send(404, { errors: [{ code: "NOT_FOUND" }] });
    }

    if(path==="/v26.0/act_1001/ads"){
      if(req.method==="GET")return send(200,{data:state.meta.hideAds?[]:state.meta.ads});
      if(req.method==="POST"){
        const creative=typeof body.creative==="string"?JSON.parse(body.creative):body.creative;
        const row={id:String(++seq),account_id:"1001",name:body.name,adset_id:body.adset_id,creative:{id:creative.creative_id},status:body.status};state.meta.ads.push(row);
        if(state.meta.loseResponses-->0){res.destroy();return;}
        return send(200,{id:row.id});
      }
    }
    if(req.method==="GET"&&path.startsWith("/v26.0/")){
      const node=state.meta.creatives.find(c=>c.id===path.slice(7))??state.meta.ads.find(a=>a.id===path.slice(7));
      return node?send(200,node):send(404,{error:{code:100}});
    }
    send(404, { error: "no_route", path });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const all: ProviderName[] = ["stripe", "hubspot", "gmail", "calendar", "slack", "zendesk", "square", "workos", "asana", "openai", "shopify", "netsuite", "easypost", "plaid", "twilio_verify", "screening", "github", "gusto", "pagerduty", "datadog", "box", "docusign", "moderntreasury", "notion"];

  return {
    state,
    faults,
    setNewSubscriptionStatus(status: string) {
      newSubStatus = status;
    },
    requests,
    base,
    endpoints(only: ProviderName[] = [...all,"meta"]) {
      return Object.fromEntries(only.map((p) => [p, { provider: p, baseUrl: base, token: `tok_${p}` }]));
    },
    engine<I>(wf: WorkflowDef<I>, opts: { only?: ProviderName[]; store?: KvStore } & Partial<EngineDeps> = {}) {
      return new Engine(wf, {
        store: opts.store ?? new MemoryStore(),
        providers: providerFactory(this.endpoints(opts.only)),
        drafter: templateDrafter,
        log: silentLogger,
        ...opts,
      });
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export type World = Awaited<ReturnType<typeof startWorld>>;

export const NOW = Date.parse("2026-10-14T12:00:00Z"); // a Wednesday
