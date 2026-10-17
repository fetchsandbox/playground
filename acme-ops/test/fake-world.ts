// One in-process HTTP server that speaks just enough of Stripe, HubSpot,
// Gmail, Calendar, Slack and Zendesk for the workflows, with state, request
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
    },
    hubspot: { contacts: [] as any[] },
    gmail: { messages: [] as { from: string }[], drafts: [] as any[] },
    calendar: { busy: [] as { start: string; end: string }[], events: [] as any[] },
    slack: { channels: new Set(["C0SUPPORT1", "C0FINANCE1", "C0CSOPS001", "C0ONBOARD1"]), messages: [] as any[] },
    zendesk: { tickets: [] as any[], comments: [] as any[], users: [] as any[], orgs: [] as any[] },
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
    if (req.method === "GET" && (r = m(/^\/v1\/subscriptions\/([^/]+)$/))) {
      const s = S.subscriptions.find((x) => x.id === r![1]);
      return s ? send(200, s) : send(404, { error: { code: "resource_missing" } });
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
      const msg = { channel: body.channel, text: body.text, ts: `${Date.now()}.${++seq}` };
      state.slack.messages.push(msg);
      return send(200, { ok: true, channel: msg.channel, ts: msg.ts });
    }

    // ---- Zendesk
    const Z = state.zendesk;
    if ((r = m(/^\/api\/v2\/tickets\/(\d+)\.json$/))) {
      const t = Z.tickets.find((x) => String(x.id) === r![1]);
      if (!t) return send(404, { error: "RecordNotFound" });
      if (req.method === "PUT") {
        const u = body.ticket;
        if (u.priority) t.priority = u.priority;
        if (u.additional_tags) t.tags = [...new Set([...(t.tags ?? []), ...u.additional_tags])];
        if (u.comment) Z.comments.push({ ticketId: t.id, ...u.comment });
      }
      return send(200, { ticket: t });
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

    send(404, { error: "no_route", path });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const all: ProviderName[] = ["stripe", "hubspot", "gmail", "calendar", "slack", "zendesk"];

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
