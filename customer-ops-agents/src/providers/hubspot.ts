import { HttpError } from "../lib/errors";
import { httpJson, withRetry } from "../lib/retry";

// HubSpot CRM v3 — https://developers.hubspot.com/docs/api/crm
// Default association type ids (HUBSPOT_DEFINED):
const ASSOC = { dealToContact: 3, noteToContact: 202, taskToContact: 204 } as const;

export interface Contact {
  id: string;
  email: string;
  firstname?: string;
  lastname?: string;
  company?: string;
  ownerId: string | null;
}

export interface Deal {
  id: string;
  name: string;
  stage: string;
  amount: string | null;
}

export interface Crm {
  findContactByEmail(email: string): Promise<Contact | null>;
  /** Create-or-get. Safe under concurrent callers for the same email. */
  upsertContact(email: string, props: { firstname?: string; lastname?: string; company?: string }): Promise<Contact>;
  listDeals(contactId: string): Promise<Deal[]>;
  createDeal(contactId: string, props: { name: string; amountCents: number; stage: string }): Promise<string>;
  updateDeal(dealId: string, props: { stage?: string; amountCents?: number }): Promise<void>;
  createNote(contactId: string, body: string): Promise<string>;
  createTask(contactId: string, t: { ownerId: string | null; subject: string; body: string }): Promise<string>;
}

interface HsObject {
  id: string;
  properties: Record<string, string | null>;
}

export class HubSpotCrm implements Crm {
  private readonly base = "https://api.hubapi.com";
  constructor(private readonly token: string) {}

  private call<T>(path: string, init: RequestInit = {}) {
    return withRetry(() =>
      httpJson<T>(`${this.base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", ...init.headers },
      }),
    );
  }

  private toContact(o: HsObject): Contact {
    const p = o.properties;
    return {
      id: o.id,
      email: p.email ?? "",
      firstname: p.firstname ?? undefined,
      lastname: p.lastname ?? undefined,
      company: p.company ?? undefined,
      ownerId: p.hubspot_owner_id || null,
    };
  }

  async findContactByEmail(email: string) {
    const res = await this.call<{ results: HsObject[] }>("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
        properties: ["email", "firstname", "lastname", "company", "hubspot_owner_id"],
        limit: 1,
      }),
    });
    const hit = res.results[0];
    return hit ? this.toContact(hit) : null;
  }

  private async getContact(id: string) {
    const o = await this.call<HsObject>(
      `/crm/v3/objects/contacts/${id}?properties=email,firstname,lastname,company,hubspot_owner_id`,
    );
    return this.toContact(o);
  }

  async upsertContact(email: string, props: { firstname?: string; lastname?: string; company?: string }) {
    const existing = await this.findContactByEmail(email);
    if (existing) return existing;
    try {
      const o = await this.call<HsObject>("/crm/v3/objects/contacts", {
        method: "POST",
        body: JSON.stringify({ properties: { email, ...props } }),
      });
      return this.toContact(o);
    } catch (err) {
      // Race: another run created it between our search and create (search is
      // also eventually consistent). HubSpot enforces unique email and returns
      // 409 "Contact already exists. Existing ID: 123" — adopt that contact.
      if (err instanceof HttpError && err.status === 409) {
        const id = /Existing ID:\s*(\d+)/.exec(err.body)?.[1];
        if (id) return this.getContact(id);
      }
      throw err;
    }
  }

  async listDeals(contactId: string) {
    const assoc = await this.call<{ results: { toObjectId: number }[] }>(
      `/crm/v4/objects/contacts/${contactId}/associations/deals?limit=20`,
    );
    if (!assoc.results.length) return [];
    const res = await this.call<{ results: HsObject[] }>("/crm/v3/objects/deals/batch/read", {
      method: "POST",
      body: JSON.stringify({
        properties: ["dealname", "dealstage", "amount"],
        inputs: assoc.results.map((r) => ({ id: String(r.toObjectId) })),
      }),
    });
    return res.results.map((d) => ({
      id: d.id,
      name: d.properties.dealname ?? "",
      stage: d.properties.dealstage ?? "",
      amount: d.properties.amount ?? null,
    }));
  }

  async createDeal(contactId: string, p: { name: string; amountCents: number; stage: string }) {
    const o = await this.call<HsObject>("/crm/v3/objects/deals", {
      method: "POST",
      body: JSON.stringify({
        properties: { dealname: p.name, amount: (p.amountCents / 100).toFixed(2), dealstage: p.stage, pipeline: "default" },
        associations: [assoc(contactId, ASSOC.dealToContact)],
      }),
    });
    return o.id;
  }

  async updateDeal(dealId: string, p: { stage?: string; amountCents?: number }) {
    const properties: Record<string, string> = {};
    if (p.stage) properties.dealstage = p.stage;
    if (p.amountCents !== undefined) properties.amount = (p.amountCents / 100).toFixed(2);
    await this.call(`/crm/v3/objects/deals/${dealId}`, { method: "PATCH", body: JSON.stringify({ properties }) });
  }

  async createNote(contactId: string, body: string) {
    const o = await this.call<HsObject>("/crm/v3/objects/notes", {
      method: "POST",
      body: JSON.stringify({
        properties: { hs_timestamp: new Date().toISOString(), hs_note_body: body },
        associations: [assoc(contactId, ASSOC.noteToContact)],
      }),
    });
    return o.id;
  }

  async createTask(contactId: string, t: { ownerId: string | null; subject: string; body: string }) {
    const o = await this.call<HsObject>("/crm/v3/objects/tasks", {
      method: "POST",
      body: JSON.stringify({
        properties: {
          hs_timestamp: new Date(Date.now() + 86_400_000).toISOString(),
          hs_task_subject: t.subject,
          hs_task_body: t.body,
          hs_task_status: "NOT_STARTED",
          hs_task_priority: "HIGH",
          ...(t.ownerId ? { hubspot_owner_id: t.ownerId } : {}),
        },
        associations: [assoc(contactId, ASSOC.taskToContact)],
      }),
    });
    return o.id;
  }
}

function assoc(contactId: string, typeId: number) {
  return { to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: typeId }] };
}
