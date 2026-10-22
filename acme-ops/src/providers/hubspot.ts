import type { ProviderHttp } from "../kit/http";

export interface HubSpotContact {
  id: string;
  properties: Record<string, string | null | undefined>;
  archived?: boolean;
}

interface SearchResponse {
  total: number;
  results: HubSpotContact[];
  paging?: { next?: { after: string } };
}

const PROPS = ["email", "firstname", "lastname", "company", "lifecyclestage", "hs_lead_status", "hubspot_owner_id", "hs_email_domain", "country", "numberofemployees", "notes_last_contacted", "createdate"];

/** HubSpot CRM v3 contacts. Email is the unique key; a 409 on create names the existing id. */
export class HubSpotClient {
  constructor(readonly http: ProviderHttp) {}

  async findByEmail(email: string, extraProps: string[] = []): Promise<HubSpotContact | undefined> {
    const { body } = await this.http.request<SearchResponse>("POST", "/crm/v3/objects/contacts/search", {
      json: { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }], properties: [...PROPS, ...extraProps], limit: 10 },
    });
    return (body?.results ?? []).find((c) => !c.archived && c.properties.email?.toLowerCase() === email.toLowerCase());
  }

  /** All contacts with `property = value`, following `after` cursors. */
  async searchEq(property: string, value: string, max = 1000): Promise<HubSpotContact[]> {
    const out: HubSpotContact[] = [];
    let after: string | undefined;
    while (out.length < max) {
      const { body } = await this.http.request<SearchResponse>("POST", "/crm/v3/objects/contacts/search", {
        json: { filterGroups: [{ filters: [{ propertyName: property, operator: "EQ", value }] }], properties: PROPS, limit: 100, after },
      });
      out.push(...(body?.results ?? []).filter((c) => !c.archived));
      after = body?.paging?.next?.after;
      if (!after || !body?.results?.length) break;
    }
    return out;
  }

  /** Contacts matching every filter (AND), up to `max`. */
  async searchAll(filters: { propertyName: string; operator: "EQ" | "NEQ" | "HAS_PROPERTY" | "NOT_HAS_PROPERTY"; value?: string }[], max = 1000): Promise<HubSpotContact[]> {
    const out: HubSpotContact[] = [];
    let after: string | undefined;
    while (out.length < max) {
      const { body } = await this.http.request<SearchResponse>("POST", "/crm/v3/objects/contacts/search", { json: { filterGroups: [{ filters }], properties: PROPS, limit: 100, after } });
      out.push(...(body?.results ?? []));
      after = body?.paging?.next?.after;
      if (!after || !body?.results?.length) break;
    }
    return out.slice(0, max);
  }

  async get(id: string, extraProps: string[] = []): Promise<HubSpotContact> {
    return (await this.http.request<HubSpotContact>("GET", `/crm/v3/objects/contacts/${encodeURIComponent(id)}`, { query: { properties: [...PROPS, ...extraProps].join(",") } })).body;
  }

  /** Email subscription statuses (Communication Preferences v3). */
  async subscriptionStatuses(email: string): Promise<{ id: string; status: string }[]> {
    const { body } = await this.http.request<any>("GET", `/communication-preferences/v3/status/email/${encodeURIComponent(email)}`);
    return (body?.subscriptionStatuses ?? []).map((s: any) => ({ id: String(s.id), status: String(s.status) }));
  }

  /** Opts the address out of one subscription type, or back in under a legal basis. */
  async setSubscription(email: string, subscriptionId: string, subscribed: boolean, legalBasisExplanation: string): Promise<{ id: string; status: string }> {
    const { body } = await this.http.request<any>("POST", `/communication-preferences/v3/${subscribed ? "subscribe" : "unsubscribe"}`, {
      json: { emailAddress: email, subscriptionId, legalBasis: "CONSENT_WITH_NOTICE", legalBasisExplanation },
    });
    return { id: String(body?.id ?? subscriptionId), status: String(body?.status ?? (subscribed ? "SUBSCRIBED" : "NOT_SUBSCRIBED")) };
  }

  async update(id: string, properties: Record<string, string>): Promise<HubSpotContact> {
    return (await this.http.request<HubSpotContact>("PATCH", `/crm/v3/objects/contacts/${encodeURIComponent(id)}`, { json: { properties } })).body;
  }

  /**
   * Create-or-update by email. A concurrent creator makes us lose the race
   * with a 409 that carries the winner's id; we adopt it and patch.
   */
  async upsertByEmail(email: string, properties: Record<string, string>): Promise<{ contact: HubSpotContact; created: boolean }> {
    const existing = await this.findByEmail(email);
    if (existing) return { contact: await this.update(existing.id, properties), created: false };
    const res = await this.http.request<any>("POST", "/crm/v3/objects/contacts", { json: { properties: { email, ...properties } }, allow: [409] });
    if (res.status !== 409) return { contact: res.body as HubSpotContact, created: true };
    const id = /Existing ID:\s*(\d+)/.exec(String(res.body?.message ?? ""))?.[1];
    if (!id) throw new Error(`hubspot 409 without an existing id for ${email}`);
    return { contact: await this.update(id, properties), created: false };
  }

  /** Permanent GDPR deletion (not the recoverable archive). */
  async gdprDelete(id: string): Promise<void> {
    await this.http.request("POST", "/crm/v3/objects/contacts/gdpr-delete", { json: { objectId: id } });
  }
}
