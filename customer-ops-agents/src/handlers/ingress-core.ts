import { createHash } from "node:crypto";
import type { Deps } from "../deps";
import { errorMessage } from "../lib/errors";
import { verifySlackSignature } from "../lib/slack-verify";
import { ttlFromNow } from "../lib/store";
import { type TaskCallbacks, approvalKey, decideApproval } from "../workflow/approval";
import type { WorkflowInput } from "../types";

export interface IngressRequest {
  path: string;
  headers: Record<string, string | undefined>;
  rawBody: string;
}
export interface IngressResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

export interface Starter {
  /** Must be idempotent for the same (name, input) — Step Functions Standard is. */
  start(name: string, input: WorkflowInput): Promise<void>;
}

export interface IngressDeps {
  signingSecret: string;
  deps: Deps;
  starter: Starter;
  callbacks: TaskCallbacks;
}

const json = (status: number, body: unknown): IngressResponse => ({ status, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const ephemeral = (text: string) => json(200, { response_type: "ephemeral", text });

/** Step Functions execution names: ≤80 chars of [A-Za-z0-9-_]. */
export const executionName = (prefix: string, id: string) => `${prefix}-${id.replace(/[^A-Za-z0-9_-]/g, "-")}`.slice(0, 80);

/**
 * Everything Slack sends lands here. Slack wants an answer within 3 seconds
 * and retries events otherwise, so this does the minimum: verify, dedupe,
 * start the execution, ack. All real work happens in Step Functions.
 */
export async function handleIngress(req: IngressRequest, x: IngressDeps): Promise<IngressResponse> {
  const ok = verifySlackSignature({
    signingSecret: x.signingSecret,
    rawBody: req.rawBody,
    timestamp: req.headers["x-slack-request-timestamp"],
    signature: req.headers["x-slack-signature"],
    nowSeconds: Math.floor(x.deps.now() / 1000),
  });
  if (!ok) return { status: 401, body: "bad signature" };

  try {
    if (req.path.endsWith("/slack/commands")) return await onCommand(new URLSearchParams(req.rawBody), x);
    if (req.path.endsWith("/slack/events")) return await onEvent(JSON.parse(req.rawBody), x);
    if (req.path.endsWith("/slack/interactions")) {
      return await onInteraction(JSON.parse(new URLSearchParams(req.rawBody).get("payload") ?? "{}"), x);
    }
    return { status: 404 };
  } catch (err) {
    x.deps.log.error("ingress failed", { err: errorMessage(err), path: req.path });
    // 5xx makes Slack retry events; retries are safe because execution names are deterministic.
    return { status: 500, body: "internal error" };
  }
}

async function onCommand(p: URLSearchParams, x: IngressDeps): Promise<IngressResponse> {
  const { deps: d } = x;
  const text = (p.get("text") ?? "").trim();
  const user = p.get("user_id") ?? "";
  const channel = p.get("channel_id") ?? "";
  if (!text) return ephemeral("Usage: `/ops <request>` — e.g. `/ops quote 20 Pro seats + onboarding for dana@acme.com, check billing and send a survey`");

  // Debounce accidental double-submits of the same request (each has a new trigger_id).
  const now = d.now();
  const digest = createHash("sha256").update(`${user}|${channel}|${text.toLowerCase()}`).digest("hex");
  const fresh = await d.store.put({ pk: `debounce#${digest}`, expiresAt: now + 60_000, ttl: ttlFromNow(120, now) }, { kind: "notExistsOrExpired", now });
  if (!fresh) return ephemeral("That exact request is already running — check the thread above.");

  let root: { ts: string };
  try {
    root = await d.chat.post(channel, `<@${user}> asked: ${text}`);
  } catch (err) {
    await d.store.delete(`debounce#${digest}`);
    return ephemeral(`I couldn't post in this channel (${errorMessage(err)}). Invite the bot with \`/invite @customer-ops\`.`);
  }

  const input: WorkflowInput = {
    runId: executionName("cmd", p.get("trigger_id") ?? digest),
    requestText: text,
    requestedBy: { userId: user, userName: p.get("user_name") ?? undefined },
    slack: { channel, threadTs: root.ts },
    receivedAt: new Date(now).toISOString(),
  };
  try {
    await x.starter.start(input.runId, input);
  } catch (err) {
    await d.store.delete(`debounce#${digest}`); // let the user retry right away
    throw err;
  }
  return ephemeral("On it — follow along in the thread.");
}

interface SlackEventEnvelope {
  type: string;
  challenge?: string;
  event_id?: string;
  event_time?: number;
  event?: { type: string; user?: string; text?: string; channel: string; ts: string; thread_ts?: string; bot_id?: string; subtype?: string };
}

async function onEvent(body: SlackEventEnvelope, x: IngressDeps): Promise<IngressResponse> {
  if (body.type === "url_verification") return json(200, { challenge: body.challenge });
  const ev = body.event;
  // Ignore bots (including ourselves) to avoid feedback loops.
  if (body.type !== "event_callback" || !ev || ev.type !== "app_mention" || ev.bot_id || ev.subtype || !body.event_id) return { status: 200 };

  const text = (ev.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!text) return { status: 200 };
  // Input must be byte-identical across Slack retries so StartExecution stays idempotent.
  const input: WorkflowInput = {
    runId: executionName("evt", body.event_id),
    requestText: text,
    requestedBy: { userId: ev.user ?? "unknown" },
    slack: { channel: ev.channel, threadTs: ev.thread_ts ?? ev.ts },
    receivedAt: new Date((body.event_time ?? 0) * 1000).toISOString(),
  };
  await x.starter.start(input.runId, input);
  return { status: 200 };
}

interface BlockActionPayload {
  type: string;
  user: { id: string };
  channel?: { id: string };
  message?: { ts: string; text?: string };
  actions?: { action_id: string; value: string }[];
}

async function onInteraction(p: BlockActionPayload, x: IngressDeps): Promise<IngressResponse> {
  const { deps: d } = x;
  const action = p.actions?.[0];
  if (p.type !== "block_actions" || !action || !["approve", "reject"].includes(action.action_id)) return { status: 200 };
  const runId = action.value;
  const rec = await d.store.get(approvalKey(runId));
  const channel = p.channel?.id ?? String(rec?.channel ?? "");
  const threadTs = String(rec?.threadTs ?? "");

  const result = await decideApproval(runId, action.action_id as "approve" | "reject", p.user.id, d, x.callbacks);
  const msgTs = p.message?.ts;
  switch (result.outcome) {
    case "recorded": {
      const verdict = result.status === "APPROVED" ? `✅ Approved by <@${p.user.id}> — sending now.` : `🛑 Rejected by <@${p.user.id}>.`;
      // Replace the buttons so nobody else can click them.
      if (msgTs) await d.chat.update(channel, msgTs, verdict, [{ type: "section", text: { type: "mrkdwn", text: verdict } }]);
      break;
    }
    case "already_decided":
      await d.chat.ephemeral(channel, p.user.id, `Already ${result.status.toLowerCase()}${result.decidedBy ? ` by <@${result.decidedBy}>` : ""}.`, threadTs);
      break;
    case "expired":
      if (msgTs) await d.chat.update(channel, msgTs, "⌛ This approval expired.", []);
      break;
    case "forbidden":
      await d.chat.ephemeral(channel, p.user.id, "You're not on the approver list for customer-ops.", threadTs);
      break;
    case "not_found":
      await d.chat.ephemeral(channel, p.user.id, "I can't find that request anymore.", threadTs);
      break;
  }
  return { status: 200 };
}
