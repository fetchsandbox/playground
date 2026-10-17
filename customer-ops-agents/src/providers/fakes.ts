// In-memory provider fakes for tests and `npm run local`. They model the
// behaviours the workflow relies on — unique-email conflicts, idempotency keys,
// injectable faults — so race and retry tests exercise real code paths.
import { RetryableError } from "../lib/errors";
import type { Billing, BillingSnapshot, CatalogPrice } from "./stripe";
import type { Chat, SlackBlock } from "./slack";
import type { Contact, Crm, Deal } from "./hubspot";
import type { Mail, ThreadSummary } from "./gmail";

const tick = () => new Promise<void>((r) => setImmediate(r));

/** Fail the next `n` calls to `method` with a retryable error. */
export class Faults {
  private pending = new Map<string, number>();
  inject(method: string, n = 1) {
    this.pending.set(method, (this.pending.get(method) ?? 0) + n);
  }
  async maybeFail(method: string) {
    await tick();
    const n = this.pending.get(method) ?? 0;
    if (n > 0) {
      this.pending.set(method, n - 1);
      throw new RetryableError(`injected fault in ${method}`);
    }
  }
}

export class FakeCrm implements Crm {
  contacts = new Map<string, Contact>();
  deals = new Map<string, Deal & { contactId: string }>();
  notes: { id: string; contactId: string; body: string }[] = [];
  tasks: { id: string; contactId: string; subject: string; ownerId: string | null }[] = [];
  createCalls = 0;
  private seq = 100;
  constructor(readonly faults = new Faults()) {}

  async findContactByEmail(email: string) {
    await this.faults.maybeFail("findContactByEmail");
    return [...this.contacts.values()].find((c) => c.email === email) ?? null;
  }
  async upsertContact(email: string, props: { firstname?: string; lastname?: string; company?: string }) {
    const found = await this.findContactByEmail(email);
    if (found) return found;
    await tick(); // widen the search→create race window, like the real API
    this.createCalls++;
    const dup = [...this.contacts.values()].find((c) => c.email === email);
    // Real HubSpot answers this with 409 "Existing ID: …", which HubSpotCrm adopts.
    if (dup) return dup;
    const c: Contact = { id: String(this.seq++), email, ownerId: "owner-1", ...props };
    this.contacts.set(c.id, c);
    return c;
  }
  async listDeals(contactId: string) {
    await this.faults.maybeFail("listDeals");
    return [...this.deals.values()].filter((d) => d.contactId === contactId);
  }
  async createDeal(contactId: string, p: { name: string; amountCents: number; stage: string }) {
    await this.faults.maybeFail("createDeal");
    const id = `deal-${this.seq++}`;
    this.deals.set(id, { id, contactId, name: p.name, stage: p.stage, amount: (p.amountCents / 100).toFixed(2) });
    return id;
  }
  async updateDeal(dealId: string, p: { stage?: string; amountCents?: number }) {
    await this.faults.maybeFail("updateDeal");
    const d = this.deals.get(dealId);
    if (d && p.stage) d.stage = p.stage;
  }
  async createNote(contactId: string, body: string) {
    await this.faults.maybeFail("createNote");
    const id = `note-${this.seq++}`;
    this.notes.push({ id, contactId, body });
    return id;
  }
  async createTask(contactId: string, t: { ownerId: string | null; subject: string; body: string }) {
    await this.faults.maybeFail("createTask");
    const id = `task-${this.seq++}`;
    this.tasks.push({ id, contactId, subject: t.subject, ownerId: t.ownerId });
    return id;
  }
}

export class FakeBilling implements Billing {
  customers = new Map<string, { id: string; email: string }>();
  quotes = new Map<string, { id: string; customerId: string; status: string; lines: { priceId: string; quantity: number }[] }>();
  private idem = new Map<string, string>();
  private seq = 1;
  catalog: CatalogPrice[] = [
    { priceId: "price_seat", lookupKey: "pro_seat_monthly", product: "Pro seat", unitAmount: 4_900, currency: "usd", interval: "month" },
    { priceId: "price_onboard", lookupKey: "onboarding_package", product: "Onboarding package", unitAmount: 150_000, currency: "usd", interval: null },
    { priceId: "price_sso", lookupKey: "sso_addon_monthly", product: "SSO add-on", unitAmount: 20_000, currency: "usd", interval: "month" },
  ];
  invoices: BillingSnapshot["invoices"] = [];
  constructor(readonly faults = new Faults()) {}

  private withKey(key: string, make: () => string) {
    const prior = this.idem.get(key);
    if (prior) return prior;
    const id = make();
    this.idem.set(key, id);
    return id;
  }
  async findCustomer(email: string) {
    await this.faults.maybeFail("findCustomer");
    return [...this.customers.values()].find((c) => c.email === email)?.id ?? null;
  }
  async createCustomer(email: string, _name: string, idempotencyKey: string) {
    await this.faults.maybeFail("createCustomer");
    return this.withKey(idempotencyKey, () => {
      const id = `cus_${this.seq++}`;
      this.customers.set(id, { id, email });
      return id;
    });
  }
  async listCatalog() {
    await this.faults.maybeFail("listCatalog");
    return this.catalog;
  }
  async snapshot(_customerId: string): Promise<BillingSnapshot> {
    await this.faults.maybeFail("snapshot");
    return { invoices: this.invoices, subscriptions: [] };
  }
  async createDraftQuote(a: { customerId: string; lines: { priceId: string; quantity: number }[]; discountPct: number; idempotencyKey: string }) {
    await this.faults.maybeFail("createDraftQuote");
    return this.withKey(a.idempotencyKey, () => {
      const id = `qt_${this.seq++}`;
      this.quotes.set(id, { id, customerId: a.customerId, status: "draft", lines: a.lines });
      return id;
    });
  }
  async finalizeQuote(quoteId: string, _key: string) {
    await this.faults.maybeFail("finalizeQuote");
    const q = this.quotes.get(quoteId)!;
    q.status = "open";
    return { number: `QT-${quoteId}`, status: q.status };
  }
}

export class FakeMail implements Mail {
  sent: { id: string; to: string; subject: string; effectKey: string }[] = [];
  threads: ThreadSummary[] = [
    { id: "t1", subject: "Re: SSO timeline", from: "dana@acme.test", date: "2026-10-01", snippet: "We need SSO before rollout" },
  ];
  constructor(readonly faults = new Faults()) {}
  async searchRecent() {
    await this.faults.maybeFail("searchRecent");
    return this.threads;
  }
  async sendOnce(msg: { to: string; subject: string; body: string; effectKey: string }) {
    const prior = this.sent.find((s) => s.effectKey === msg.effectKey);
    if (prior) return { id: prior.id, deduped: true };
    await this.faults.maybeFail("sendOnce");
    const id = `msg-${this.sent.length + 1}`;
    this.sent.push({ id, to: msg.to, subject: msg.subject, effectKey: msg.effectKey });
    return { id, deduped: false };
  }
}

export class FakeChat implements Chat {
  messages: { channel: string; ts: string; text: string; threadTs?: string; blocks?: SlackBlock[] }[] = [];
  private seq = 1;
  async post(channel: string, text: string, opts: { threadTs?: string; blocks?: SlackBlock[] } = {}) {
    await tick();
    const ts = `1700000000.${String(this.seq++).padStart(6, "0")}`;
    this.messages.push({ channel, ts, text, ...opts });
    return { ts };
  }
  async update(channel: string, ts: string, text: string, blocks?: SlackBlock[]) {
    await tick();
    const m = this.messages.find((x) => x.channel === channel && x.ts === ts);
    if (m) Object.assign(m, { text, blocks });
  }
  async ephemeral(channel: string, _user: string, text: string, threadTs?: string) {
    await this.post(channel, `(ephemeral) ${text}`, { threadTs });
  }
}
