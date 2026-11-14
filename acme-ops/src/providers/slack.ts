import { ProviderError } from "../kit/errors";
import type { ProviderHttp } from "../kit/http";

/**
 * Slack Web API. Slack reports most failures as HTTP 200 with `ok: false`,
 * so the envelope is checked here and turned into a typed error.
 */
export class SlackClient {
  constructor(readonly http: ProviderHttp) {}

  async postMessage(channel: string, text: string, blocks?: unknown[], threadTs?: string): Promise<{ channel: string; ts: string }> {
    const { body } = await this.http.request<any>("POST", "/api/chat.postMessage", {
      json: { channel, text, blocks, ...(threadTs ? { thread_ts: threadTs } : {}), unfurl_links: false, unfurl_media: false },
    });
    if (body?.ok !== true) {
      const code = String(body?.error ?? "not_ok");
      throw new ProviderError("slack", 200, code, code === "ratelimited", `chat.postMessage → ${code}`);
    }
    return { channel: String(body.channel ?? channel), ts: String(body.ts) };
  }

  /** One post, never retried on timeout/5xx (Slack has no idempotency key): reconcile with history first. */
  async postMessageOnce(channel: string, text: string): Promise<{ channel: string; ts: string }> {
    const { body } = await this.http.request<any>("POST", "/api/chat.postMessage", { json: { channel, text, unfurl_links: false, unfurl_media: false }, idempotent: false });
    if (body?.ok !== true) {
      const code = String(body?.error ?? "not_ok");
      throw new ProviderError("slack", 200, code, code === "ratelimited", `chat.postMessage → ${code}`);
    }
    return { channel: String(body.channel ?? channel), ts: String(body.ts) };
  }

  /** Latest messages of a channel (conversations.history). */
  async history(channel: string, limit = 100): Promise<{ ts: string; text: string }[]> {
    const { body } = await this.http.request<any>("GET", "/api/conversations.history", { query: { channel, limit } });
    if (body?.ok !== true) {
      const code = String(body?.error ?? "not_ok");
      throw new ProviderError("slack", 200, code, code === "ratelimited", `conversations.history → ${code}`);
    }
    return (body.messages ?? []).map((m: any) => ({ ts: String(m.ts), text: String(m.text ?? "") }));
  }
}
