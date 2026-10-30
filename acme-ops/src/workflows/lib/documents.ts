import { z } from "zod";
import type { Providers } from "../../providers";
import { type DocumentStore, documentStore, safeName } from "../../providers/storage";

// Shared building blocks for document workflows (DocuSign, Box, Dropbox).
// Everything a company would change (where documents go, how they're named,
// which templates a packet holds) is policy; these helpers only interpret it.

/** Where documents are filed: Box (root = a folder id) or Dropbox (root = a path, "" for the root). */
export const StorePolicy = z
  .object({
    provider: z.enum(["box", "dropbox"]).describe("Document store: box or dropbox"),
    root: z.string().describe('Box: the root folder id ("0" is All Files). Dropbox: a path such as "/Acme" ("" is the account or team root)'),
  })
  .describe("Where documents are filed");
export type StorePolicy = z.infer<typeof StorePolicy>;

/** A Slack channel id, or null for "don't post". */
export const ChannelPolicy = z.string().regex(/^[CG][A-Z0-9]{6,}$/, "Slack channel id").nullable();

/**
 * Fills `{name}` placeholders. Each value is made safe for a file or folder name, so a value
 * can never add a path segment of its own ("../", "/").
 */
export function fill(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = vars[k];
    return v === undefined || v === null || v === "" ? "unknown" : safeName(String(v));
  });
}

/** Placeholders a template uses that the workflow doesn't provide (checked at startup by the schema). */
export const unknownPlaceholders = (template: string, known: readonly string[]) => [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).filter((k) => !known.includes(k));

/** A zod refinement: the template only uses placeholders from `known`. */
export const templateString = (known: readonly string[], what: string) =>
  z
    .string()
    .min(1)
    .superRefine((t, ctx) => {
      const bad = unknownPlaceholders(t, known);
      if (bad.length) ctx.addIssue({ code: "custom", message: `${what} uses unknown placeholder(s) ${bad.join(", ")}; allowed: ${known.join(", ")}` });
    })
    .describe(`${what}; placeholders: ${known.map((k) => `{${k}}`).join(" ")}`);

/**
 * First rule whose every condition matches. A condition is a list of allowed values
 * (case-insensitive); a missing or empty condition matches anything.
 */
export function firstMatch<R extends { match: Record<string, string[] | undefined> }>(rules: R[], facts: Record<string, string | undefined>): R | undefined {
  return rules.find((r) => Object.entries(r.match).every(([k, allowed]) => !allowed?.length || allowed.some((a) => a.toLowerCase() === (facts[k] ?? "").toLowerCase())));
}

/** The configured store, or a clear error naming the missing provider. */
export function storeOf(providers: Providers, cfg: StorePolicy): DocumentStore {
  const store = documentStore(providers, cfg);
  if (!store) throw new Error(`${cfg.provider} is the policy's document store but isn't configured`);
  return store;
}

export const DAY = 86_400_000;
/** Midday UTC on a date, so date-based timers don't drift across time zones. */
export const onDate = (date: string, days = 0) => new Date(Date.parse(`${date.slice(0, 10)}T15:00:00Z`) + days * DAY).toISOString();
