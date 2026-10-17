import { FatalError } from "../lib/errors";
import { httpJson, withRetry } from "../lib/retry";

// Slack Web API — https://docs.slack.dev/reference/methods
export interface SlackBlock {
  type: string;
  [k: string]: unknown;
}

export interface Chat {
  post(channel: string, text: string, opts?: { threadTs?: string; blocks?: SlackBlock[] }): Promise<{ ts: string }>;
  update(channel: string, ts: string, text: string, blocks?: SlackBlock[]): Promise<void>;
  ephemeral(channel: string, user: string, text: string, threadTs?: string): Promise<void>;
}

export class SlackChat implements Chat {
  constructor(private readonly botToken: string) {}

  private async api<T extends { ok: boolean; error?: string }>(method: string, body: Record<string, unknown>) {
    const res = await withRetry(() =>
      httpJson<T>(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.botToken}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
      }),
    );
    // Slack reports most failures as HTTP 200 + ok:false.
    if (!res.ok) throw new FatalError(`slack ${method}: ${res.error}`);
    return res;
  }

  async post(channel: string, text: string, opts: { threadTs?: string; blocks?: SlackBlock[] } = {}) {
    const res = await this.api<{ ok: boolean; error?: string; ts: string }>("chat.postMessage", {
      channel,
      text,
      thread_ts: opts.threadTs,
      blocks: opts.blocks,
      unfurl_links: false,
    });
    return { ts: res.ts };
  }

  async update(channel: string, ts: string, text: string, blocks?: SlackBlock[]) {
    await this.api("chat.update", { channel, ts, text, blocks: blocks ?? [] });
  }

  async ephemeral(channel: string, user: string, text: string, threadTs?: string) {
    await this.api("chat.postEphemeral", { channel, user, text, thread_ts: threadTs });
  }
}
