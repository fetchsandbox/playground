import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod/v3";
import {
  kvKeyForInvoice,
  normalizeInvoiceKey,
  type ProcessedInvoiceRecord,
} from "../lib/invoice-key.js";

const inputSchema = z.object({
  invoiceKey: z
    .string()
    .min(3)
    .describe("Stable key: merchant|invoiceIdOrDate|amount"),
  merchant: z.string().min(1),
  amount: z.string().min(1),
  renewalDate: z.string().optional(),
  cancelBy: z.string().optional(),
  calendarEventId: z.string().optional(),
  slackMessageRef: z.string().optional(),
  source: z
    .string()
    .min(1)
    .describe("gmail:<messageId> or paste:<fingerprint>"),
  dryRun: z
    .boolean()
    .optional()
    .describe("True when Calendar/Slack writes were stubbed or skipped"),
});

export default defineTool({
  description:
    "Record that a subscription invoice was handled so later turns skip duplicates. Call after Calendar + Slack actions (or dry-run stubs).",
  effect: "write",
  inputSchema,
  dryRunResult: (input) => ({
    recorded: false as const,
    dryRun: true as const,
    invoiceKey: normalizeInvoiceKey(input.invoiceKey),
    stubbed: true as const,
  }),
  async execute(input, ctx) {
    const invoiceKey = normalizeInvoiceKey(input.invoiceKey);
    const storageKey = kvKeyForInvoice(invoiceKey);
    const existing = (await ctx.host.kv.get(
      storageKey,
    )) as ProcessedInvoiceRecord | null;

    if (existing && !existing.dryRun) {
      return {
        recorded: false as const,
        alreadyProcessed: true as const,
        invoiceKey,
        record: existing,
      };
    }

    const record: ProcessedInvoiceRecord = {
      invoiceKey,
      merchant: input.merchant.trim(),
      amount: input.amount.trim(),
      renewalDate: input.renewalDate,
      cancelBy: input.cancelBy,
      calendarEventId: input.calendarEventId,
      slackMessageRef: input.slackMessageRef,
      source: input.source.trim(),
      dryRun: input.dryRun ?? false,
      processedAt: new Date().toISOString(),
    };

    await ctx.host.kv.put(storageKey, record);

    return {
      recorded: true as const,
      alreadyProcessed: false as const,
      invoiceKey,
      record,
    };
  },
});
