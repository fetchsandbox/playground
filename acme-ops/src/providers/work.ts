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
    const out: any[] = [];
    for (let page = 1; out.length < max; page++) {
      const { body } = await this.http.request<any[]>("GET", `/repos/${repo}/dependabot/alerts`, { query: { state: "open", per_page: 100, page } });
      const rows = Array.isArray(body) ? body : [];
      out.push(...rows);
      if (rows.length < 100) break;
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
  async openIncidents(serviceIds: string[]): Promise<{ id: string; urgency: string; status: string; title?: string; priority?: { summary?: string } | null }[]> {
    const { body } = await this.http.request<any>("GET", "/incidents", { query: { "service_ids[]": serviceIds.join(","), "statuses[]": "triggered,acknowledged", limit: 100 } });
    return (body?.incidents ?? []).filter((i: any) => !serviceIds.length || serviceIds.includes(i.service?.id));
  }

  /** Who is on call now for this escalation policy. */
  async onCall(escalationPolicyId: string): Promise<{ user: { id: string; summary?: string } }[]> {
    const { body } = await this.http.request<any>("GET", "/oncalls", { query: { "escalation_policy_ids[]": escalationPolicyId, earliest: "true" } });
    return body?.oncalls ?? [];
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
  constructor(readonly http: ProviderHttp, private readonly uploadUrl = "") {}

  /** Uploads a new file (multipart, Box's upload host in production). */
  async upload(folderId: string, name: string, content: string): Promise<{ id: string; name: string }> {
    const boundary = `acme${Date.now().toString(36)}`;
    const body = [`--${boundary}`, 'Content-Disposition: form-data; name="attributes"', "", JSON.stringify({ name, parent: { id: folderId } }), `--${boundary}`, `Content-Disposition: form-data; name="file"; filename="${name}"`, "Content-Type: application/json", "", content, `--${boundary}--`, ""].join("\r\n");
    const { body: res } = await this.http.request<any>("POST", `${this.uploadUrl}/files/content`, { raw: { body, contentType: `multipart/form-data; boundary=${boundary}` } });
    const f = res?.entries?.[0] ?? res;
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
    const path = url.replace(/^https?:\/\/[^/]+(\/2\.0)?/, "");
    const res = await this.http.request<any>("GET", path);
    return typeof res.body === "string" ? res.body : (res.body?.raw ?? JSON.stringify(res.body ?? ""));
  }

  /** The file's bytes, base64 (for e-signature envelopes). */
  async downloadBase64(fileId: string): Promise<string> {
    const res = await this.http.request<any>("GET", `/files/${encodeURIComponent(fileId)}/content`);
    return Buffer.from(typeof res.body === "string" ? res.body : (res.body?.raw ?? JSON.stringify(res.body ?? "")), "utf8").toString("base64");
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

  async remind(id: string): Promise<void> {
    await this.http.request("PUT", `/v2.1/accounts/${encodeURIComponent(this.accountId)}/envelopes/${encodeURIComponent(id)}/recipients`, { query: { resend_envelope: "true" }, json: {} });
  }

  async void(id: string, reason: string): Promise<void> {
    await this.http.request("PUT", `/v2.1/accounts/${encodeURIComponent(this.accountId)}/envelopes/${encodeURIComponent(id)}`, { json: { status: "voided", voidedReason: reason } });
  }
}
