// Work-management, identity, engineering, messaging and document systems.
// Each client speaks the vendor's own REST paths, so the same code runs against
// production and a FetchSandbox twin by swapping the base URL.
import type { ProviderHttp } from "../kit/http";

/** Asana tasks: ACME's work orders, CAPAs, RMAs and IT tickets. */
export interface AsanaTask {
  gid: string;
  name: string;
  notes?: string;
  due_on?: string | null;
  completed?: boolean;
}

export class AsanaClient {
  constructor(readonly http: ProviderHttp) {}

  async createTask(task: { name: string; notes: string; workspace: string; projects?: string[]; due_on?: string; assignee?: string }): Promise<AsanaTask> {
    const { body } = await this.http.request<any>("POST", "/tasks", { json: { data: task } });
    // Asana returns { data: { gid, ... } }; some backends put the id beside data.
    return { ...body.data, gid: String(body.data?.gid && body.data.gid !== "12345" ? body.data.gid : (body.id ?? body.data?.gid)) };
  }

  async getTask(gid: string): Promise<AsanaTask> {
    const { body } = await this.http.request<any>("GET", `/tasks/${encodeURIComponent(gid)}`);
    return { ...body.data, gid };
  }

  async updateTask(gid: string, patch: Partial<Pick<AsanaTask, "due_on" | "completed" | "notes" | "name">>): Promise<AsanaTask> {
    const { body } = await this.http.request<any>("PUT", `/tasks/${encodeURIComponent(gid)}`, { json: { data: patch } });
    return { ...body.data, gid };
  }

  async comment(gid: string, text: string): Promise<{ gid: string }> {
    const { body } = await this.http.request<any>("POST", `/tasks/${encodeURIComponent(gid)}/stories`, { json: { data: { text } } });
    return { gid: String(body.data?.gid ?? body.id) };
  }
}

/** WorkOS User Management: ACME's identity directory (stand-in for Okta / Entra ID). */
export interface WorkOSUser {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  last_sign_in_at?: string | null;
  external_id?: string | null;
}
export interface WorkOSMembership {
  id: string;
  user_id: string;
  organization_id: string;
  status: string;
  role?: { slug: string };
}

export class WorkOSClient {
  constructor(readonly http: ProviderHttp) {}

  async findUserByEmail(email: string): Promise<WorkOSUser | undefined> {
    const { body } = await this.http.request<any>("GET", "/user_management/users", { query: { email, limit: 10 } });
    return (body?.data ?? []).find((u: WorkOSUser) => u.email?.toLowerCase() === email.toLowerCase());
  }

  async listUsers(max = 500): Promise<WorkOSUser[]> {
    const out: WorkOSUser[] = [];
    let after: string | undefined;
    const seen = new Set<string>();
    while (out.length < max) {
      const { body } = await this.http.request<any>("GET", "/user_management/users", { query: { limit: 100, after } });
      // Stop when a page adds nothing new: some servers hand back a cursor forever.
      const fresh = ((body?.data ?? []) as WorkOSUser[]).filter((u) => !seen.has(u.id));
      fresh.forEach((u) => seen.add(u.id));
      out.push(...fresh);
      after = body?.list_metadata?.after ?? undefined;
      if (!after || !fresh.length) break;
    }
    return out.slice(0, max);
  }

  async getUser(id: string): Promise<WorkOSUser> {
    return (await this.http.request<WorkOSUser>("GET", `/user_management/users/${encodeURIComponent(id)}`)).body;
  }

  async createUser(u: { email: string; first_name: string; last_name?: string; external_id?: string }): Promise<WorkOSUser> {
    return (await this.http.request<WorkOSUser>("POST", "/user_management/users", { json: u })).body;
  }

  async deleteUser(id: string): Promise<void> {
    await this.http.request("DELETE", `/user_management/users/${encodeURIComponent(id)}`);
  }

  async createMembership(userId: string, organizationId: string, roleSlug: string): Promise<WorkOSMembership> {
    return (await this.http.request<WorkOSMembership>("POST", "/user_management/organization_memberships", { json: { user_id: userId, organization_id: organizationId, role_slug: roleSlug } })).body;
  }

  async getMembership(id: string): Promise<WorkOSMembership> {
    return (await this.http.request<WorkOSMembership>("GET", `/user_management/organization_memberships/${encodeURIComponent(id)}`)).body;
  }

  async listMemberships(userId: string): Promise<WorkOSMembership[]> {
    const { body } = await this.http.request<any>("GET", "/user_management/organization_memberships", { query: { user_id: userId, limit: 100 } });
    return Array.isArray(body?.data) ? body.data.filter((m: WorkOSMembership) => m.user_id === userId) : [];
  }

  async deleteMembership(id: string): Promise<void> {
    await this.http.request("DELETE", `/user_management/organization_memberships/${encodeURIComponent(id)}`);
  }
}

/** GitHub issues: ACME engineering's change records (PCN / EOL) and IT requests. */
export interface GitHubIssue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  labels: (string | { name: string })[];
}

export const labelNames = (i: GitHubIssue) => i.labels.map((l) => (typeof l === "string" ? l : l.name));

export class GitHubClient {
  constructor(readonly http: ProviderHttp) {}

  async getIssue(repo: string, n: number): Promise<GitHubIssue> {
    return (await this.http.request<GitHubIssue>("GET", `/repos/${repo}/issues/${n}`)).body;
  }

  async createIssue(repo: string, issue: { title: string; body: string; labels?: string[] }): Promise<GitHubIssue> {
    return (await this.http.request<GitHubIssue>("POST", `/repos/${repo}/issues`, { json: issue })).body;
  }

  async setLabels(repo: string, n: number, labels: string[]): Promise<GitHubIssue> {
    return (await this.http.request<GitHubIssue>("PATCH", `/repos/${repo}/issues/${n}`, { json: { labels } })).body;
  }
}

/** Twilio Programmable Messaging: SMS to site contacts. */
export class TwilioClient {
  constructor(
    readonly http: ProviderHttp,
    private readonly accountSid: string,
  ) {}

  async sendSms(to: string, from: string, body: string): Promise<{ sid: string; status: string }> {
    const { body: res } = await this.http.request<any>("POST", `/2010-04-01/Accounts/${this.accountSid}/Messages.json`, { form: { To: to, From: from, Body: body } });
    return { sid: res.sid, status: res.status };
  }

  async getMessage(sid: string): Promise<{ sid: string; status: string; to: string }> {
    return (await this.http.request<any>("GET", `/2010-04-01/Accounts/${this.accountSid}/Messages/${encodeURIComponent(sid)}.json`)).body;
  }
}

/** PagerDuty REST v2: incident notes (incidents arrive as webhook payloads). */
export class PagerDutyClient {
  constructor(
    readonly http: ProviderHttp,
    private readonly fromEmail: string,
  ) {}

  async addNote(incidentId: string, content: string): Promise<{ id: string }> {
    const { body } = await this.http.request<any>("POST", `/incidents/${encodeURIComponent(incidentId)}/notes`, {
      json: { note: { content } },
      headers: { From: this.fromEmail },
    });
    return { id: String(body?.note?.id ?? body?.id ?? "") };
  }
}

/** Notion: ACME's approved-answer library for security questionnaires. */
export class NotionClient {
  constructor(readonly http: ProviderHttp) {}

  async queryDatabase(databaseId: string, max = 500): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | undefined;
    while (out.length < max) {
      const { body } = await this.http.request<any>("POST", `/v1/databases/${encodeURIComponent(databaseId)}/query`, { json: { page_size: 100, start_cursor: cursor } });
      out.push(...(body?.results ?? []));
      if (!body?.has_more || !body?.next_cursor) break;
      cursor = body.next_cursor;
    }
    return out;
  }

  async createPage(databaseId: string, title: string, markdownish: string): Promise<{ id: string }> {
    const { body } = await this.http.request<any>("POST", "/v1/pages", {
      json: {
        parent: { database_id: databaseId },
        properties: { Name: { title: [{ text: { content: title.slice(0, 200) } }] } },
        children: markdownish
          .split("\n")
          .filter(Boolean)
          .slice(0, 90)
          .map((line) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: line.slice(0, 1900) } }] } })),
      },
    });
    return { id: body.id };
  }
}

/** Box: ACME's controlled-document library (compliance declarations, certificates). */
export interface BoxFile {
  id: string;
  name: string;
  type: string;
}

export class BoxClient {
  constructor(readonly http: ProviderHttp) {}

  async search(query: string, ancestorFolderId?: string): Promise<BoxFile[]> {
    const { body } = await this.http.request<any>("GET", "/search", { query: { query, type: "file", ancestor_folder_ids: ancestorFolderId, limit: 50 } });
    return (body?.entries ?? []).filter((e: BoxFile) => e?.type === "file");
  }

  async createSharedLink(fileId: string, expiresAt: string): Promise<{ url: string }> {
    const { body } = await this.http.request<any>("PUT", `/files/${encodeURIComponent(fileId)}`, {
      query: { fields: "shared_link" },
      json: { shared_link: { access: "open", unshared_at: expiresAt, permissions: { can_download: true } } },
    });
    return { url: body?.shared_link?.url };
  }
}

/**
 * Trade.gov Consolidated Screening List (restricted-party screening).
 * https://developer.trade.gov/apis — `GET /consolidated_screening_list/v1/search`.
 */
export class ScreeningClient {
  constructor(readonly http: ProviderHttp) {}

  async search(name: string, country?: string): Promise<{ name: string; source: string; score?: number }[]> {
    const { body } = await this.http.request<any>("GET", "/consolidated_screening_list/v1/search", { query: { name, countries: country, fuzzy_name: "true", size: 25 } });
    return (body?.results ?? []).map((r: any) => ({ name: r.name, source: r.source, score: r.score }));
  }
}
