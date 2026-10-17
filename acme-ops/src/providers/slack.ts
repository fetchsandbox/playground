import { ProviderError } from "../kit/errors";
import type { ProviderHttp } from "../kit/http";

/**
 * Slack Web API. Slack reports most failures as HTTP 200 with `ok: false`,
 * so the envelope is checked here and turned into a typed error.
 */
export class SlackClient {
  constructor(private readonly http: ProviderHttp) {}

  async postMessage(channel: string, text: string, blocks?: unknown[]): Promise<{ channel: string; ts: string }> {
    const { body } = await this.http.request<any>("POST", "/api/chat.postMessage", {
      json: { channel, text, blocks, unfurl_links: false, unfurl_media: false },
    });
    if (body?.ok !== true) {
      const code = String(body?.error ?? "not_ok");
      throw new ProviderError("slack", 200, code, code === "ratelimited", `chat.postMessage → ${code}`);
    }
    return { channel: String(body.channel ?? channel), ts: String(body.ts) };
  }
}
