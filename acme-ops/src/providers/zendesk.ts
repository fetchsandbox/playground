import type { ProviderHttp } from "../kit/http";

export interface ZendeskTicket {
  id: number;
  subject?: string;
  description?: string;
  status?: string;
  priority?: string | null;
  tags?: string[];
  requester_id?: number;
  organization_id?: number | null;
  created_at?: string;
}

export interface ZendeskUser {
  id: number;
  email?: string;
  name?: string;
  organization_id?: number | null;
}

/**
 * Zendesk Support REST API v2 (https://developer.zendesk.com/api-reference/).
 * Paths are Zendesk's own, so the same client works against
 * https://<subdomain>.zendesk.com and a FetchSandbox Zendesk twin.
 */
export class ZendeskClient {
  constructor(readonly http: ProviderHttp) {}

  async getTicket(id: number | string): Promise<ZendeskTicket> {
    const { body } = await this.http.request<{ ticket: ZendeskTicket }>("GET", `/api/v2/tickets/${encodeURIComponent(String(id))}.json`);
    return body.ticket;
  }

  async getUser(id: number): Promise<ZendeskUser> {
    const { body } = await this.http.request<{ user: ZendeskUser }>("GET", `/api/v2/users/${id}.json`);
    return body.user;
  }

  /** Update fields and optionally add a comment (internal unless `public`). */
  async updateTicket(
    id: number | string,
    update: { priority?: string; tags?: string[]; comment?: { body: string; public: boolean } },
  ): Promise<ZendeskTicket> {
    const ticket: Record<string, unknown> = {};
    if (update.priority) ticket.priority = update.priority;
    if (update.tags) ticket.additional_tags = update.tags;
    if (update.comment) ticket.comment = update.comment;
    const { body } = await this.http.request<{ ticket: ZendeskTicket }>("PUT", `/api/v2/tickets/${encodeURIComponent(String(id))}.json`, { json: { ticket } });
    return body.ticket;
  }

  /** Search API (`type:ticket ...`), first `max` results. */
  async searchTickets(query: string, max = 100): Promise<ZendeskTicket[]> {
    const out: ZendeskTicket[] = [];
    let page = 1;
    while (out.length < max) {
      const { body } = await this.http.request<{ results: ZendeskTicket[]; next_page?: string | null }>("GET", "/api/v2/search.json", {
        query: { query: `type:ticket ${query}`, page, per_page: 100 },
      });
      out.push(...(body?.results ?? []));
      if (!body?.next_page || !body.results?.length) break;
      page++;
    }
    return out.slice(0, max);
  }

  async createOrUpdateOrganization(name: string, externalId: string): Promise<{ id: number }> {
    const { body } = await this.http.request<{ organization: { id: number } }>("POST", "/api/v2/organizations/create_or_update.json", {
      json: { organization: { name, external_id: externalId } },
    });
    return body.organization;
  }

  async createOrUpdateUser(email: string, name: string, organizationId?: number): Promise<ZendeskUser> {
    const { body } = await this.http.request<{ user: ZendeskUser }>("POST", "/api/v2/users/create_or_update.json", {
      json: { user: { email, name, organization_id: organizationId, verified: true } },
    });
    return body.user;
  }
}
