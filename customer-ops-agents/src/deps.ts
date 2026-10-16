import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { ClaudeLlm, type Llm } from "./lib/llm";
import { createLogger, type Logger } from "./lib/log";
import { DynamoStore, type KvStore } from "./lib/store";
import { GmailMail, type Mail } from "./providers/gmail";
import { HubSpotCrm, type Crm } from "./providers/hubspot";
import { SlackChat, type Chat } from "./providers/slack";
import { StripeBilling, type Billing } from "./providers/stripe";

export interface AppConfig {
  /** Max discount the quote agent may apply without the approver being warned. */
  maxAutoDiscountPct: number;
  /** Don't survey the same customer more often than this. */
  surveyCooldownDays: number;
  /** HubSpot owner used when the contact has none. */
  defaultOwnerId: string | null;
  /** Slack user ids allowed to approve. Empty = anyone in the channel. */
  approverUserIds: string[];
  dealStage: { quoted: string; sent: string };
}

export interface Deps {
  store: KvStore;
  llm: Llm;
  crm: Crm;
  billing: Billing;
  mail: Mail;
  /** Present when a Slack bot token is configured; otherwise messages only go to the run's event log. */
  chat?: Chat;
  config: AppConfig;
  log: Logger;
  now: () => number;
}

/** Shape of the JSON stored in the Secrets Manager secret (see README). */
export interface Secrets {
  ANTHROPIC_API_KEY: string;
  STRIPE_SECRET_KEY: string;
  HUBSPOT_TOKEN: string;
  /** Optional. Without it the agent never posts to Slack; LoopLabs reads events via `status`. */
  SLACK_BOT_TOKEN?: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
  GMAIL_SENDER: string;
}

let secretsPromise: Promise<Secrets> | undefined;

/** Cached per container; falls back to env vars when SECRET_ARN is unset (local dev). */
export function loadSecrets(): Promise<Secrets> {
  secretsPromise ??= (async () => {
    const arn = process.env.SECRET_ARN;
    if (!arn) return process.env as unknown as Secrets;
    const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
    return JSON.parse(out.SecretString ?? "{}") as Secrets;
  })();
  secretsPromise.catch(() => (secretsPromise = undefined)); // don't cache a failure
  return secretsPromise;
}

export function configFromEnv(env = process.env): AppConfig {
  return {
    maxAutoDiscountPct: Number(env.MAX_AUTO_DISCOUNT_PCT ?? 15),
    surveyCooldownDays: Number(env.SURVEY_COOLDOWN_DAYS ?? 30),
    defaultOwnerId: env.DEFAULT_OWNER_ID || null,
    approverUserIds: (env.APPROVER_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    dealStage: { quoted: env.DEAL_STAGE_QUOTED ?? "presentationscheduled", sent: env.DEAL_STAGE_SENT ?? "decisionmakerboughtin" },
  };
}

let depsPromise: Promise<Deps> | undefined;

export function getDeps(): Promise<Deps> {
  depsPromise ??= (async () => {
    const s = await loadSecrets();
    const table = process.env.TABLE_NAME;
    if (!table) throw new Error("TABLE_NAME is not set");
    return {
      store: new DynamoStore(table),
      llm: new ClaudeLlm(s.ANTHROPIC_API_KEY, process.env.CLAUDE_MODEL || "claude-opus-5-5"),
      crm: new HubSpotCrm(s.HUBSPOT_TOKEN),
      billing: new StripeBilling(s.STRIPE_SECRET_KEY),
      mail: new GmailMail({
        clientId: s.GOOGLE_CLIENT_ID,
        clientSecret: s.GOOGLE_CLIENT_SECRET,
        refreshToken: s.GOOGLE_REFRESH_TOKEN,
        sender: s.GMAIL_SENDER,
      }),
      chat: s.SLACK_BOT_TOKEN ? new SlackChat(s.SLACK_BOT_TOKEN) : undefined,
      config: configFromEnv(),
      log: createLogger({ service: "customer-ops-agents" }),
      now: Date.now,
    };
  })();
  depsPromise.catch(() => (depsPromise = undefined));
  return depsPromise;
}
