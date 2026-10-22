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
  updated_at?: string;
  external_id?: string | null;
}

export interface ZendeskComment {
  id: number;
  body?: string;
  public?: boolean;
  author_id?: number;
  created_at?: string;
}

export interface ZendeskUser {
  id: number;
  email?: string;
  name?: string;
  organization_id?: number | null;
  locale?: string | null;
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
    const { body } = await this.http.request<{ user?: ZendeskUser } & ZendeskUser>("GET", `/api/v2/users/${id}.json`);
    // Zendesk wraps the user; the FetchSandbox twin returns it bare.
    return body.user ?? body;
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

  /** New ticket for a request that arrived outside Zendesk (e.g. a phone call logged by the IVR). */
  async createTicket(t: { subject: string; body: string; requester: { email: string; name?: string }; tags: string[]; externalId: string }): Promise<ZendeskTicket> {
    const { body } = await this.http.request<{ ticket: ZendeskTicket }>("POST", "/api/v2/tickets.json", {
      json: { ticket: { subject: t.subject, comment: { body: t.body, public: false }, requester: t.requester, tags: t.tags, external_id: t.externalId } },
    });
    return body.ticket;
  }

  async findTicketsByExternalId(externalId: string): Promise<ZendeskTicket[]> {
    const { body } = await this.http.request<{ tickets?: ZendeskTicket[] }>("GET", "/api/v2/tickets.json", { query: { external_id: externalId } });
    return body?.tickets ?? [];
  }

  async listComments(id: number | string): Promise<ZendeskComment[]> {
    const { body } = await this.http.request<{ comments?: ZendeskComment[] }>("GET", `/api/v2/tickets/${encodeURIComponent(String(id))}/comments.json`);
    return body?.comments ?? [];
  }

  /** One comment (public ones are emailed to the requester), optionally moving the ticket's status. */
  async addComment(id: number | string, comment: { body: string; public: boolean }, status?: "open" | "pending" | "solved"): Promise<ZendeskTicket> {
    const { body } = await this.http.request<{ ticket: ZendeskTicket }>("PUT", `/api/v2/tickets/${encodeURIComponent(String(id))}.json`, {
      json: { ticket: { comment, ...(status ? { status } : {}) } },
    });
    return body.ticket;
  }

  /**
   * Adds tags by read-modify-write under Zendesk's safe update, so a tag an
   * agent added in between is never overwritten (a stale stamp is a 409 and
   * is retried against the fresh ticket).
   */
  async addTags(id: number | string, tags: string[]): Promise<ZendeskTicket> {
    for (let attempt = 0; ; attempt++) {
      const cur = await this.getTicket(id);
      const merged = [...new Set([...(cur.tags ?? []), ...tags])];
      if (merged.length === (cur.tags ?? []).length) return cur;
      const res = await this.http.request<{ ticket?: ZendeskTicket }>("PUT", `/api/v2/tickets/${encodeURIComponent(String(id))}.json`, {
        json: { ticket: { tags: merged, safe_update: true, updated_stamp: cur.updated_at } },
        allow: attempt < 2 ? [409] : [],
      });
      if (res.status !== 409) return res.body?.ticket ?? cur;
    }
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
