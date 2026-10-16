import type { Deps } from "../deps";
import { once } from "../lib/idempotency";
import type { SlackBlock } from "../providers/slack";
import type { WorkflowInput } from "../types";

export const runKey = (runId: string) => `run#${runId}`;

export interface RunEvent {
  at: number;
  key: string;
  text: string;
}

/**
 * Every message the workflow emits goes to the run's event log (what
 * LoopLabs reads through `status`), and to the Slack thread too when a bot
 * token and a thread are configured. At most once per `key`, across retries
 * and resumed runs.
 */
export function notify(d: Deps, input: WorkflowInput, key: string, text: string, blocks?: SlackBlock[]): Promise<{ ts: string | null }> {
  return once(d.store, `${input.runId}:notify:${key}`, async () => {
    let ts: string | null = null;
    if (d.chat && input.slack) ts = (await d.chat.post(input.slack.channel, text, { threadTs: input.slack.threadTs, blocks })).ts;
    const event: RunEvent = { at: d.now(), key, text };
    await d.store.append(runKey(input.runId), "events", [event]);
    return { ts };
  });
}

/** Replace an earlier Slack message (e.g. remove approval buttons). No-op without Slack. */
export async function replaceMessage(d: Deps, input: WorkflowInput, ts: string | null | undefined, text: string) {
  if (!d.chat || !input.slack || !ts) return;
  await d.chat.update(input.slack.channel, ts, text, [{ type: "section", text: { type: "mrkdwn", text } }]);
}
