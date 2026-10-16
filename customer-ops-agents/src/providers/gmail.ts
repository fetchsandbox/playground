import { createHash } from "node:crypto";
import { httpJson, withRetry } from "../lib/retry";

// Gmail REST v1 — https://developers.google.com/workspace/gmail/api/reference/rest

export interface ThreadSummary {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
}

export interface Mail {
  searchRecent(query: string, max?: number): Promise<ThreadSummary[]>;
  /**
   * Send at most once per `effectKey`. The Message-ID header is derived from
   * the key and Sent mail is checked for it first, so a retry after an
   * ambiguous failure (timeout after Gmail accepted) does not double-send.
   */
  sendOnce(msg: { to: string; subject: string; body: string; effectKey: string }): Promise<{ id: string; deduped: boolean }>;
}

export interface GoogleOAuth {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Mailbox to act as (the OAuth user). */
  sender: string;
}

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailMail implements Mail {
  private token?: { value: string; exp: number };
  constructor(private readonly oauth: GoogleOAuth) {}

  private async accessToken() {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const res = await withRetry(() =>
      httpJson<{ access_token: string; expires_in: number }>("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: this.oauth.clientId,
          client_secret: this.oauth.clientSecret,
          refresh_token: this.oauth.refreshToken,
        }),
      }),
    );
    this.token = { value: res.access_token, exp: Date.now() + res.expires_in * 1000 };
    return this.token.value;
  }

  private async call<T>(path: string, init: RequestInit = {}) {
    const token = await this.accessToken();
    return withRetry(() =>
      httpJson<T>(`${API}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
      }),
    );
  }

  async searchRecent(query: string, max = 5) {
    const list = await this.call<{ messages?: { id: string }[] }>(
      `/messages?${new URLSearchParams({ q: query, maxResults: String(max) })}`,
    );
    const ids = list.messages?.map((m) => m.id) ?? [];
    return Promise.all(
      ids.map(async (id) => {
        const m = await this.call<{ id: string; snippet: string; payload: { headers: { name: string; value: string }[] } }>(
          `/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        );
        const h = (n: string) => m.payload.headers.find((x) => x.name.toLowerCase() === n)?.value ?? "";
        return { id: m.id, subject: h("subject"), from: h("from"), date: h("date"), snippet: m.snippet };
      }),
    );
  }

  async sendOnce(msg: { to: string; subject: string; body: string; effectKey: string }) {
    const messageId = `<${createHash("sha256").update(msg.effectKey).digest("hex").slice(0, 32)}@customer-ops.local>`;
    const prior = await this.call<{ messages?: { id: string }[] }>(
      `/messages?${new URLSearchParams({ q: `in:sent rfc822msgid:${messageId}`, maxResults: "1" })}`,
    );
    const hit = prior.messages?.[0];
    if (hit) return { id: hit.id, deduped: true };

    const raw = [
      `From: ${this.oauth.sender}`,
      `To: ${sanitizeHeader(msg.to)}`,
      `Subject: ${encodeHeader(msg.subject)}`,
      `Message-ID: ${messageId}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      msg.body,
    ].join("\r\n");
    const sent = await this.call<{ id: string }>("/messages/send", {
      method: "POST",
      body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url") }),
    });
    return { id: sent.id, deduped: false };
  }
}

/** Strip CR/LF so model- or user-supplied text can't inject extra headers. */
function sanitizeHeader(v: string) {
  return v.replace(/[\r\n]+/g, " ").trim();
}

function encodeHeader(v: string) {
  const clean = sanitizeHeader(v);
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean).toString("base64")}?=`;
}
