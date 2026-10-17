import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentResults } from "../kit/types";

export const Email = z.string().trim().toLowerCase().pipe(z.email());
/** Slack channel id (C…, G…, D…). Names are ambiguous; ids are not. */
export const ChannelId = z.string().regex(/^[CGD][A-Z0-9]{6,}$/, "Slack channel id like C0123ABCD");

export const Approvers = z.array(z.string().min(1)).max(50).optional();

/** Typed access to an agent's output; undefined when it failed or was skipped. */
export function out<T>(results: AgentResults, name: string): T | undefined {
  return results.ok[name] as T | undefined;
}

export function shortHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

/** Deterministic RFC 5322 Message-ID for a draft created by (run, purpose). */
export function messageId(runId: string, purpose: string): string {
  return `<${shortHash(runId, purpose)}.${purpose}@ops.acme.example>`;
}

export function money(minor: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(minor / 100);
}

/** Lowercased, Slack-safe one-liners: never echo raw customer text into mrkdwn. */
export function plain(text: string, max = 300): string {
  return text.replace(/[<>&*_~`]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
