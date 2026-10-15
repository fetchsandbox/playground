import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod/v3";
import {
  kvKeyForInvoice,
  normalizeInvoiceKey,
  type ProcessedInvoiceRecord,
} from "../lib/invoice-key.js";

export default defineTool({
  description:
    "Check whether this subscription invoice was already processed (calendar + Slack). Call before creating reminders.",
  effect: "read",
  inputSchema: z.object({
    invoiceKey: z
      .string()
      .min(3)
      .describe("Stable key: merchant|invoiceIdOrDate|amount"),
  }),
  async execute({ invoiceKey }, ctx) {
    const key = normalizeInvoiceKey(invoiceKey);
    const stored = (await ctx.host.kv.get(
      kvKeyForInvoice(key),
    )) as ProcessedInvoiceRecord | null;

    if (!stored) {
      return { processed: false as const, invoiceKey: key };
    }

    return {
      processed: true as const,
      invoiceKey: key,
      record: stored,
    };
  },
});
