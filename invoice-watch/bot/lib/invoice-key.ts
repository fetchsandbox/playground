/** Normalize a merchant|id|amount invoice key for kv dedupe. */
export function normalizeInvoiceKey(invoiceKey: string): string {
  return invoiceKey
    .trim()
    .toLowerCase()
    .split("|")
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("|");
}

export type ProcessedInvoiceRecord = {
  invoiceKey: string;
  merchant: string;
  amount: string;
  renewalDate?: string;
  cancelBy?: string;
  calendarEventId?: string;
  slackMessageRef?: string;
  source: string;
  dryRun: boolean;
  processedAt: string;
};

export function kvKeyForInvoice(invoiceKey: string): string {
  return `invoice:${normalizeInvoiceKey(invoiceKey)}`;
}
