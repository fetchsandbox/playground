// Work-management, identity, engineering, messaging and document systems.
// Each client speaks the vendor's own REST paths, so the same code runs against
// production and a FetchSandbox twin by swapping the base URL.
import { SpecDeviation } from "../kit/errors";
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

  async listOrganizationMemberships(organizationId: string): Promise<WorkOSMembership[]> {
    const { body } = await this.http.request<any>("GET", "/user_management/organization_memberships", { query: { organization_id: organizationId, limit: 100 } });
    return Array.isArray(body?.data) ? body.data.filter((m: WorkOSMembership) => m.organization_id === organizationId) : [];
  }

  /** Active sessions of one user. */
  async listSessions(userId: string): Promise<{ id: string }[]> {
    const { body } = await this.http.request<any>("GET", `/user_management/users/${encodeURIComponent(userId)}/sessions`, { query: { limit: 100 } });
    return body?.data ?? [];
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.http.request("POST", "/user_management/sessions/revoke", { json: { session_id: sessionId } });
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

  async getPullRequest(repo: string, n: number): Promise<{ number: number; state: string; merged: boolean; merge_commit_sha: string | null; head: { sha: string }; base: { ref: string }; user: { login: string } }> {
    return (await this.http.request<any>("GET", `/repos/${repo}/pulls/${n}`)).body;
  }

  async listReviews(repo: string, n: number): Promise<{ user: { login: string }; state: string }[]> {
    const { body } = await this.http.request<any>("GET", `/repos/${repo}/pulls/${n}/reviews`, { query: { per_page: 100 } });
    return Array.isArray(body) ? body : [];
  }

  /** Combined check-run conclusion for a commit. */
  async checkRuns(repo: string, sha: string): Promise<{ name: string; status: string; conclusion: string | null }[]> {
    const { body } = await this.http.request<any>("GET", `/repos/${repo}/commits/${sha}/check-runs`, { query: { per_page: 100 } });
    return body?.check_runs ?? [];
  }

  async createDeployment(repo: string, d: { ref: string; environment: string; description: string; payload: Record<string, unknown> }): Promise<{ id: number; sha?: string }> {
    return (await this.http.request<any>("POST", `/repos/${repo}/deployments`, { json: { ref: d.ref, environment: d.environment, description: d.description, payload: d.payload, auto_merge: false, required_contexts: [] } })).body;
  }

  async listDeployments(repo: string, environment: string): Promise<{ id: number; sha: string; ref: string; payload?: Record<string, unknown> }[]> {
    const { body } = await this.http.request<any>("GET", `/repos/${repo}/deployments`, { query: { environment, per_page: 30 } });
    return Array.isArray(body) ? body : [];
  }

  async setDeploymentStatus(repo: string, id: number, state: "in_progress" | "success" | "failure" | "inactive", description: string): Promise<{ id: number; state: string }> {
    return (await this.http.request<any>("POST", `/repos/${repo}/deployments/${id}/statuses`, { json: { state, description, auto_inactive: true } })).body;
  }

  /** Open Dependabot alerts of a repository. */
  async dependabotAlerts(repo: string, max = 1_000): Promise<{ number: number; state: string; created_at: string; security_advisory: { ghsa_id: string; severity: string; summary: string }; dependency: { package: { name: string; ecosystem: string } }; security_vulnerability?: { first_patched_version?: { identifier: string } | null } }[]> {
    // Cursor pagination via the Link header (GitHub removed page/first/last for this endpoint on 2025-10-14).
    const out: any[] = [];
    let next: string | undefined = `/repos/${repo}/dependabot/alerts`;
    let query: Record<string, string | number> | undefined = { state: "open", per_page: 100 };
    while (next && out.length < max) {
      const res: { body: any[]; headers?: Record<string, string> } = await this.http.request<any[]>("GET", next, { query });
      out.push(...(Array.isArray(res.body) ? res.body : []));
      next = /<([^>]+)>;\s*rel="next"/.exec(res.headers?.link ?? "")?.[1];
      query = undefined;
    }
    return out.slice(0, max);
  }

  async getDependabotAlert(repo: string, n: number): Promise<{ number: number; state: string }> {
    return (await this.http.request<any>("GET", `/repos/${repo}/dependabot/alerts/${n}`)).body;
  }

  async setDependabotAlert(repo: string, n: number, patch: { state: "dismissed" | "open"; dismissed_reason?: "tolerable_risk" | "no_bandwidth" | "inaccurate" | "not_used" | "fix_started"; dismissed_comment?: string }): Promise<{ number: number; state: string }> {
    return (await this.http.request<any>("PATCH", `/repos/${repo}/dependabot/alerts/${n}`, { json: patch })).body;
  }

  /** Issues carrying a label (open and closed). */
  async issuesWithLabel(repo: string, label: string): Promise<GitHubIssue[]> {
    const { body } = await this.http.request<GitHubIssue[]>("GET", `/repos/${repo}/issues`, { query: { labels: label, state: "all", per_page: 100 } });
    return Array.isArray(body) ? body : [];
  }

  async comment(repo: string, n: number, body: string): Promise<{ id: number }> {
    return (await this.http.request<any>("POST", `/repos/${repo}/issues/${n}/comments`, { json: { body } })).body;
  }

  async addLabels(repo: string, n: number, labels: string[]): Promise<void> {
    await this.http.request("POST", `/repos/${repo}/issues/${n}/labels`, { json: { labels } });
  }

  /** Organization members with a role (admin | member), following Link pagination. */
  async listOrgMembers(org: string, role: "admin" | "member", max = 5_000): Promise<{ login: string; id: number }[]> {
    const out: { login: string; id: number }[] = [];
    for (let page = 1; out.length < max; page++) {
      const { body } = await this.http.request<{ login: string; id: number }[]>("GET", `/orgs/${encodeURIComponent(org)}/members`, { query: { role, per_page: 100, page } });
      const rows = Array.isArray(body) ? body : [];
      out.push(...rows);
      if (rows.length < 100) break;
    }
    return out.slice(0, max);
  }

  async getOrgMembership(org: string, username: string): Promise<{ role: string; state: string } | undefined> {
    const res = await this.http.request<{ role: string; state: string }>("GET", `/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(username)}`, { allow: [404] });
    return res.status === 404 ? undefined : res.body;
  }

  /** Removes the user from the organization (and its teams and repositories). */
  async removeOrgMember(org: string, username: string): Promise<void> {
    await this.http.request("DELETE", `/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(username)}`);
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

  /** Open (triggered or acknowledged) incidents on these services. */
  async openIncidents(serviceIds: string[]): Promise<{ id: string; urgency: string; status: string; title?: string; incident_key?: string | null; priority?: { summary?: string } | null }[]> {
    const { body } = await this.http.request<any>("GET", "/incidents", { query: { "service_ids[]": serviceIds, "statuses[]": ["triggered", "acknowledged"], limit: 100 } });
    return (body?.incidents ?? []).filter((i: any) => !serviceIds.length || serviceIds.includes(i.service?.id));
  }

  /** Who is on call now for this escalation policy. */
  async onCall(escalationPolicyId: string): Promise<{ user: { id: string; summary?: string } }[]> {
    const { body } = await this.http.request<any>("GET", "/oncalls", { query: { "escalation_policy_ids[]": escalationPolicyId, earliest: "true" } });
    return body?.oncalls ?? [];
  }

  /** Opens an incident; `incident_key` de-duplicates a re-sent page while the first is open. */
  async createIncident(i: { serviceId: string; title: string; incidentKey: string; details: string; urgency: "high" | "low" }): Promise<{ id: string; status: string }> {
    const { body } = await this.http.request<any>("POST", "/incidents", {
      json: { incident: { type: "incident", title: i.title, service: { id: i.serviceId, type: "service_reference" }, urgency: i.urgency, incident_key: i.incidentKey, body: { type: "incident_body", details: i.details } } },
      headers: { From: this.fromEmail },
    });
    return { id: String(body?.incident?.id), status: String(body?.incident?.status) };
  }

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

  async getPage(id: string): Promise<{ id: string; last_edited_time?: string; properties: Record<string, any> }> {
    return (await this.http.request<any>("GET", `/v1/pages/${encodeURIComponent(id)}`)).body;
  }

  /** Sets plain properties: select by name, date by ISO date, rich text by string. */
  async updatePage(id: string, props: Record<string, { select: string } | { date: string } | { text: string }>): Promise<{ id: string }> {
    const value = (v: { select: string } | { date: string } | { text: string }) => ("select" in v ? { select: { name: v.select } } : "date" in v ? { date: { start: v.date } } : { rich_text: [{ type: "text", text: { content: v.text.slice(0, 1900) } }] });
    const properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, value(v)]));
    return (await this.http.request<any>("PATCH", `/v1/pages/${encodeURIComponent(id)}`, { json: { properties } })).body;
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
export interface BoxSharedLink {
  url: string;
  access: "open" | "company" | "collaborators";
  effective_access?: string;
  unshared_at: string | null;
  is_password_enabled?: boolean;
  download_count?: number;
}
export interface BoxItem {
  type: "file" | "folder" | "web_link";
  id: string;
  name: string;
  modified_at?: string;
  shared_link?: BoxSharedLink | null;
}

export interface BoxFile {
  id: string;
  name: string;
  type: string;
}

export class BoxClient {
  /** Box takes uploads on a separate host (upload.box.com/api/2.0); `uploadUrl` overrides it, e.g. for a test double. */
  constructor(readonly http: ProviderHttp, private readonly uploadUrl = "https://upload.box.com/api/2.0") {}

  /** Uploads a new file (multipart, Box's upload host in production). */
  async upload(folderId: string, name: string, content: string): Promise<{ id: string; name: string }> {
    const boundary = `acme${Date.now().toString(36)}`;
    const body = [`--${boundary}`, 'Content-Disposition: form-data; name="attributes"', "", JSON.stringify({ name, parent: { id: folderId } }), `--${boundary}`, `Content-Disposition: form-data; name="file"; filename="${name}"`, "Content-Type: application/json", "", content, `--${boundary}--`, ""].join("\r\n");
    const { body: res } = await this.http.request<any>("POST", `${this.uploadUrl}/files/content`, { raw: { body, contentType: `multipart/form-data; boundary=${boundary}` } });
    // Box answers { total_count, entries: [file] }.
    const f = res?.entries?.[0];
    if (!f?.id) throw new SpecDeviation("box", "POST /files/content returned no entries[0].id");
    return { id: String(f.id), name: f.name };
  }

  async search(query: string, ancestorFolderId?: string): Promise<BoxFile[]> {
    const { body } = await this.http.request<any>("GET", "/search", { query: { query, type: "file", ancestor_folder_ids: ancestorFolderId, limit: 50 } });
    return (body?.entries ?? []).filter((e: BoxFile) => e?.type === "file");
  }

  async getFile(fileId: string): Promise<{ id: string; name: string; extension?: string; size?: number }> {
    return (await this.http.request<any>("GET", `/files/${encodeURIComponent(fileId)}`, { query: { fields: "name,extension,size" } })).body;
  }

  /** Box's extracted-text representation of a document (PDF, DOCX), or null when Box hasn't produced one. */
  async extractedText(fileId: string): Promise<string | null> {
    const { body } = await this.http.request<any>("GET", `/files/${encodeURIComponent(fileId)}`, { query: { fields: "representations" }, headers: { "x-rep-hints": "[extracted_text]" } });
    const rep = body?.representations?.entries?.find((e: any) => e.representation === "extracted_text");
    const url: string | undefined = rep?.content?.url_template?.replace("{+asset_path}", "");
    if (!url || rep?.status?.state !== "success") return null;
    // Box: call the url_template as given (dl.boxcloud.com); the body is plain text.
    return (await this.http.request<string>("GET", url, { responseType: "text" })).body;
  }

  /** The file's bytes, base64 (for e-signature envelopes). */
  async downloadBase64(fileId: string): Promise<string> {
    // Box redirects to dl.boxcloud.com with the raw bytes.
    return (await this.http.request<string>("GET", `/files/${encodeURIComponent(fileId)}/content`, { responseType: "base64" })).body;
  }

  /**
   * Uploads bytes (a signed PDF, a scan). Box: multipart to upload.box.com, `attributes` part before
   * the `file` part; a name already in the folder answers 409 item_name_in_use.
   */
  async uploadBytes(folderId: string, name: string, bytes: Uint8Array, contentType = "application/pdf"): Promise<{ id: string; name: string }> {
    const boundary = `acme${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const head = [`--${boundary}`, 'Content-Disposition: form-data; name="attributes"', "", JSON.stringify({ name, parent: { id: folderId } }), `--${boundary}`, `Content-Disposition: form-data; name="file"; filename="${name.replace(/"/g, "")}"`, `Content-Type: ${contentType}`, "", ""].join("\r\n");
    const body = Buffer.concat([Buffer.from(head, "utf8"), Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")]);
    const { body: res } = await this.http.request<any>("POST", `${this.uploadUrl}/files/content`, { raw: { body, contentType: `multipart/form-data; boundary=${boundary}` } });
    const f = res?.entries?.[0];
    if (!f?.id) throw new SpecDeviation("box", "POST /files/content returned no entries[0].id");
    return { id: String(f.id), name: f.name };
  }

  /** Every item in a folder (marker paging), with the fields asked for. */
  async folderItems(folderId: string, fields = "name,type"): Promise<BoxItem[]> {
    const items: BoxItem[] = [];
    let marker: string | undefined;
    do {
      const { body } = await this.http.request<any>("GET", `/folders/${encodeURIComponent(folderId)}/items`, { query: { fields, limit: 1000, usemarker: "true", marker } });
      if (!Array.isArray(body?.entries)) throw new SpecDeviation("box", "GET /folders/{id}/items returned no entries[]");
      items.push(...body.entries.map((e: any) => ({ ...e, id: String(e.id) })));
      marker = body.next_marker || undefined;
    } while (marker);
    return items;
  }

  /** Creates a sub-folder; Box answers 409 item_name_in_use when it already exists (the caller re-reads). */
  async createFolder(parentId: string, name: string): Promise<{ id: string; name: string } | { conflict: true }> {
    const { status, body } = await this.http.request<any>("POST", "/folders", { json: { name, parent: { id: parentId } }, allow: [409] });
    if (status === 409) return { conflict: true };
    return { id: String(body.id), name: body.name };
  }

  /** Changes or removes (`null`) a file's or folder's shared link. */
  async setSharedLink(type: "file" | "folder", id: string, link: { access?: "open" | "company" | "collaborators"; unshared_at?: string | null } | null): Promise<BoxSharedLink | null> {
    const { body } = await this.http.request<any>("PUT", `/${type}s/${encodeURIComponent(id)}`, { query: { fields: "shared_link" }, json: { shared_link: link } });
    return body?.shared_link ?? null;
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
    // The CSL API authenticates with a developer.trade.gov `subscription-key` header.
    const { body } = await this.http.request<any>("GET", "/consolidated_screening_list/v1/search", { query: { name, countries: country, fuzzy_name: "true", size: 25 }, headers: { "subscription-key": this.http.endpoint.token } });
    return (body?.results ?? []).map((r: any) => ({ name: r.name, source: r.source, score: r.score }));
  }
}

/** Datadog monitors and metrics (https://docs.datadoghq.com/api/latest/). */
export class DatadogClient {
  constructor(readonly http: ProviderHttp, private readonly appKey = "") {}

  /** Datadog authenticates with DD-API-KEY / DD-APPLICATION-KEY (twins also take the bearer token). */
  private get headers() {
    return { "DD-API-KEY": this.http.endpoint.token, ...(this.appKey ? { "DD-APPLICATION-KEY": this.appKey } : {}) };
  }

  async monitor(id: number): Promise<{ id: number; name: string; overall_state: string }> {
    return (await this.http.request<any>("GET", `/api/v1/monitor/${id}`, { headers: this.headers })).body;
  }

  /** Last value of a metric query over the window (e.g. an error rate). */
  async lastValue(query: string, fromSec: number, toSec: number): Promise<number | null> {
    const { body } = await this.http.request<any>("GET", "/api/v1/query", { query: { query, from: fromSec, to: toSec }, headers: this.headers });
    const points: [number, number | null][] = body?.series?.[0]?.pointlist ?? [];
    const last = [...points].reverse().find((p) => p[1] !== null);
    return last ? last[1] : null;
  }
}

/** DocuSign eSignature REST v2.1 (https://developers.docusign.com/docs/esign-rest-api/reference/). Base URL ends in /restapi. */
export interface DocuSignEnvelope {
  envelopeId: string;
  status: string;
  emailSubject?: string;
  sentDateTime?: string;
  completedDateTime?: string | null;
  recipients?: { signers?: { email: string; name: string; roleName?: string; status: string; signedDateTime?: string }[] };
  customFields?: { textCustomFields?: { name: string; value: string }[]; listCustomFields?: { name: string; value: string }[] };
}

export class DocuSignClient {
  constructor(readonly http: ProviderHttp, readonly accountId: string) {}

  async createEnvelope(e: { subject: string; documentBase64: string; documentName: string; signers: { email: string; name: string }[]; externalId: string }): Promise<{ envelopeId: string; status: string }> {
    const { body } = await this.http.request<any>("POST", `/v2.1/accounts/${encodeURIComponent(this.accountId)}/envelopes`, {
      json: {
        emailSubject: e.subject,
        documents: [{ documentBase64: e.documentBase64, name: e.documentName, fileExtension: "pdf", documentId: "1" }],
        recipients: { signers: e.signers.map((s, i) => ({ email: s.email, name: s.name, recipientId: String(i + 1), routingOrder: String(i + 1) })) },
        customFields: { textCustomFields: [{ name: "acme_external_id", value: e.externalId, show: "false" }] },
        status: "sent",
      },
    });
    return { envelopeId: body.envelopeId, status: body.status };
  }

  async getEnvelope(id: string): Promise<{ envelopeId: string; status: string; completedDateTime?: string | null }> {
    return (await this.http.request<any>("GET", `/v2.1/accounts/${encodeURIComponent(this.accountId)}/envelopes/${encodeURIComponent(id)}`)).body;
  }

  /** Envelopes carrying our external id (so a retry never sends twice). */
  async findByExternalId(externalId: string, fromDate: string): Promise<{ envelopeId: string; status: string }[]> {
    const { body } = await this.http.request<any>("GET", `/v2.1/accounts/${encodeURIComponent(this.accountId)}/envelopes`, { query: { from_date: fromDate, custom_field: `acme_external_id=${externalId}` } });
    return body?.envelopes ?? [];
  }

  private get base() {
    return `/v2.1/accounts/${encodeURIComponent(this.accountId)}`;
  }

  /**
   * Sends an envelope built from server templates (composite templates: one per document, in order),
   * each role filled by a recipient. DocuSign's own reminders and expiry come from `notification`.
   */
  async createFromTemplates(e: { subject: string; blurb?: string; templateIds: string[]; roles: { roleName: string; email: string; name: string }[]; externalId: string; reminders?: { delayDays: number; everyDays: number }; expireDays?: number }): Promise<{ envelopeId: string; status: string }> {
    const recipients = { signers: e.roles.map((r, i) => ({ email: r.email, name: r.name, roleName: r.roleName, recipientId: String(i + 1), routingOrder: String(i + 1) })) };
    const { body } = await this.http.request<any>("POST", `${this.base}/envelopes`, {
      json: {
        emailSubject: e.subject,
        ...(e.blurb ? { emailBlurb: e.blurb } : {}),
        compositeTemplates: e.templateIds.map((templateId, i) => ({
          compositeTemplateId: String(i + 1),
          serverTemplates: [{ sequence: "1", templateId }],
          inlineTemplates: [{ sequence: "2", recipients }],
        })),
        customFields: { textCustomFields: [{ name: "acme_external_id", value: e.externalId, show: "false" }] },
        ...(e.reminders || e.expireDays
          ? {
              notification: {
                useAccountDefaults: "false",
                ...(e.reminders ? { reminders: { reminderEnabled: "true", reminderDelay: String(e.reminders.delayDays), reminderFrequency: String(e.reminders.everyDays) } } : {}),
                ...(e.expireDays ? { expirations: { expireEnabled: "true", expireAfter: String(e.expireDays), expireWarn: String(Math.max(1, Math.min(3, e.expireDays - 1))) } } : {}),
              },
            }
          : {}),
        status: "sent",
      },
    });
    if (!body?.envelopeId) throw new SpecDeviation("docusign", "POST /envelopes returned no envelopeId");
    return { envelopeId: body.envelopeId, status: body.status };
  }

  /** An envelope with its recipients and custom fields (`include=recipients,custom_fields`). */
  async getEnvelopeDetail(id: string): Promise<DocuSignEnvelope> {
    const { body } = await this.http.request<any>("GET", `${this.base}/envelopes/${encodeURIComponent(id)}`, { query: { include: "recipients,custom_fields" } });
    if (!body?.envelopeId || typeof body.status !== "string") throw new SpecDeviation("docusign", "GET /envelopes/{id} returned no envelopeId/status");
    return body;
  }

  /** The values signers entered (`GET .../form_data`), flattened to name → value. */
  async formData(id: string): Promise<Record<string, string>> {
    const { body } = await this.http.request<any>("GET", `${this.base}/envelopes/${encodeURIComponent(id)}/form_data`);
    return Object.fromEntries(((body?.formData ?? []) as { name: string; value: string }[]).map((f) => [f.name, f.value]));
  }

  /**
   * The signed documents as one PDF (`documents/combined`), base64. With `certificate`, DocuSign
   * appends the certificate of completion.
   */
  async combinedPdfBase64(id: string, certificate = true): Promise<string> {
    return (await this.http.request<string>("GET", `${this.base}/envelopes/${encodeURIComponent(id)}/documents/combined`, { query: { certificate: String(certificate) }, responseType: "base64", headers: { accept: "application/pdf" } })).body;
  }

  /** Envelopes whose status changed since `fromDate` (ISO), optionally filtered by status. */
  async listChanged(fromDate: string, status?: string): Promise<{ envelopeId: string; status: string; emailSubject?: string; completedDateTime?: string | null }[]> {
    const out: any[] = [];
    let start = 0;
    for (;;) {
      const { body } = await this.http.request<any>("GET", `${this.base}/envelopes`, { query: { from_date: fromDate, status, start_position: start, count: 100 } });
      const page = body?.envelopes ?? [];
      out.push(...page);
      const total = Number(body?.totalSetSize ?? out.length);
      if (!page.length || out.length >= total) return out;
      start = out.length;
    }
  }

  async remind(id: string): Promise<void> {
    await this.http.request("PUT", `/v2.1/accounts/${encodeURIComponent(this.accountId)}/envelopes/${encodeURIComponent(id)}/recipients`, { query: { resend_envelope: "true" }, json: {} });
  }

  async void(id: string, reason: string): Promise<void> {
    await this.http.request("PUT", `/v2.1/accounts/${encodeURIComponent(this.accountId)}/envelopes/${encodeURIComponent(id)}`, { json: { status: "voided", voidedReason: reason } });
  }
}
