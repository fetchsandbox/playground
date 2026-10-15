/**
 * Gmail provider contracts.
 *
 * Source of truth:
 * - MCP: https://developers.google.com/workspace/gmail/api/reference/mcp/tools_list/search_threads
 * - MCP: https://developers.google.com/workspace/gmail/api/reference/mcp/tools_list/get_message
 * - REST: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
 * - REST: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
 *
 * Gmail MCP `search_threads.query` uses the same operators as the Gmail
 * search box / `users.messages.list` `q` parameter.
 */

export const GMAIL_MCP_CONNECTION = "gmail";

/** Default invoice/subscription search using Gmail search operators. */
export function buildInvoiceSearchQuery(newerThan = "7d"): string {
  const window = newerThan.trim() || "7d";
  return [
    "(",
    'subject:(invoice OR receipt OR renewal OR subscription)',
    ' OR "your invoice"',
    ' OR "billing period"',
    ")",
    ` newer_than:${window}`,
    " -category:promotions",
    " -category:social",
  ].join("");
}

/** Official Gmail MCP `search_threads` arguments. */
export type SearchThreadsArgs = {
  query: string;
  pageSize?: number;
  pageToken?: string;
  includeTrash?: boolean;
  view?: "THREAD_VIEW_MINIMAL" | "THREAD_VIEW_METADATA_ONLY";
};

export function buildSearchThreadsArgs(input: {
  query?: string;
  newerThan?: string;
  pageSize?: number;
  pageToken?: string;
}): SearchThreadsArgs {
  const pageSize = Math.min(Math.max(input.pageSize ?? 20, 1), 50);
  return {
    query: input.query?.trim() || buildInvoiceSearchQuery(input.newerThan),
    pageSize,
    ...(input.pageToken ? { pageToken: input.pageToken } : {}),
    includeTrash: false,
    view: "THREAD_VIEW_MINIMAL",
  };
}

/** Official Gmail MCP `get_message` arguments. */
export type GetMessageArgs = {
  messageId: string;
  messageFormat?: "FULL_CONTENT" | "MINIMAL" | "METADATA_ONLY";
};

export function buildGetMessageArgs(
  messageId: string,
  messageFormat: GetMessageArgs["messageFormat"] = "FULL_CONTENT",
): GetMessageArgs {
  return { messageId: messageId.trim(), messageFormat };
}

/** Parallel REST shapes for documentation / twin verification. */
export function toRestMessagesList(args: SearchThreadsArgs) {
  return {
    method: "GET" as const,
    url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
    query: {
      q: args.query,
      maxResults: args.pageSize ?? 20,
      ...(args.pageToken ? { pageToken: args.pageToken } : {}),
      includeSpamTrash: args.includeTrash ?? false,
    },
  };
}

export function toRestMessagesGet(args: GetMessageArgs) {
  return {
    method: "GET" as const,
    url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(args.messageId)}`,
    query: {
      format:
        args.messageFormat === "METADATA_ONLY"
          ? "metadata"
          : args.messageFormat === "MINIMAL"
            ? "minimal"
            : "full",
    },
  };
}
