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
      disputes: [] as any[],
      accounts: [] as any[],
      transfers: [] as any[],
      /** Idempotency-Key → transfer, as real Stripe keeps for 24h. */
      transferKeys: new Map<string, any>(),
      /** Lose this many transfer responses after the transfer was created (the effect happens, the reply doesn't). */
      loseTransferResponses: 0,
    },
    hubspot: { contacts: [] as any[] },
    gmail: { messages: [] as { from: string }[], drafts: [] as any[] },
    calendar: { busy: [] as { start: string; end: string }[], events: [] as any[] },
    slack: { channels: new Set(["C0SUPPORT1", "C0FINANCE1", "C0CSOPS001", "C0ONBOARD1"]), messages: [] as any[] },
    zendesk: { tickets: [] as any[], comments: [] as any[], users: [] as any[], orgs: [] as any[] },
    workos: { users: [] as any[], memberships: [] as any[], sessions: [] as any[] },
    asana: { tasks: [] as any[] },
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
      return send(200, { data: S.customers.filter((c) => !email || c.email === email), has_more: false });
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
    if (req.method === "GET" && path === "/v1/disputes") return send(200, { data: S.disputes, has_more: false });
    if (req.method === "GET" && (r = m(/^\/v1\/refunds\/([^/]+)$/))) {
      const rf = S.refunds.find((x) => x.id === r![1]);
      return rf ? send(200, rf) : send(404, { error: { code: "resource_missing" } });
    }
    if (req.method === "GET" && path === "/v1/invoices") {
      return send(200, { data: S.invoices.filter((i) => (!q.get("customer") || i.customer === q.get("customer")) && (!q.get("status") || i.status === q.get("status"))), has_more: false });
    }
    if (req.method === "GET" && path === "/v1/refunds") return send(200, { data: S.refunds, has_more: false });

    // ---- HubSpot
    const H = state.hubspot;
    if (req.method === "POST" && path === "/crm/v3/objects/contacts/search") {
      const f = body.filterGroups?.[0]?.filters?.[0];
      const results = H.contacts.filter((c) => String(c.properties[f.propertyName] ?? "").toLowerCase() === String(f.value).toLowerCase());
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
      if (!state.slack.channels.has(body.channel)) return send(200, { ok: false, error: "channel_not_found" });
      const msg = { channel: body.channel, text: body.text, ts: `${Date.now()}.${++seq}`, ...(body.thread_ts ? { thread_ts: body.thread_ts } : {}) };
      state.slack.messages.push(msg);
      return send(200, { ok: true, channel: msg.channel, ts: msg.ts });
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

    send(404, { error: "no_route", path });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const all: ProviderName[] = ["stripe", "hubspot", "gmail", "calendar", "slack", "zendesk", "square", "workos", "asana"];

  return {
    state,
    faults,
    setNewSubscriptionStatus(status: string) {
      newSubStatus = status;
    },
    requests,
    base,
    endpoints(only: ProviderName[] = all) {
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
