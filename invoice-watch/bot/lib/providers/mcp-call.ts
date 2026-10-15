type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type McpCallResult = {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

type McpToolInfo = { name: string };

type McpRegistry = {
  names(): string[];
  listTools(connectionName: string): Promise<McpToolInfo[]>;
  callTool(
    connectionName: string,
    toolName: string,
    args?: Record<string, unknown>,
  ): Promise<McpCallResult>;
};

export type ProviderCallResult = {
  ok: boolean;
  connection: string;
  tool: string;
  callArguments: { [key: string]: JsonValue };
  structuredContent?: { [key: string]: JsonValue };
  text?: string;
  error?: string;
};

function asJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(asJsonValue);
  }
  if (typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = asJsonValue(entry);
    }
    return out;
  }
  return String(value);
}

function asJsonObject(
  value: Record<string, unknown> | undefined,
): { [key: string]: JsonValue } | undefined {
  if (!value) return undefined;
  return asJsonValue(value) as { [key: string]: JsonValue };
}

function toolNameMatches(actual: string, expected: string): boolean {
  return (
    actual === expected ||
    actual.endsWith(`_${expected}`) ||
    actual.endsWith(`__${expected}`) ||
    actual.includes(expected)
  );
}

/**
 * Call a provider MCP tool by official name. Tries preferred connections
 * first (official Google MCP URLs), then any other mounted connection that
 * exposes the same tool name.
 */
export async function callProviderTool(
  mcp: McpRegistry,
  preferredConnections: string[],
  tool: string,
  args: Record<string, unknown>,
): Promise<ProviderCallResult> {
  const callArguments = asJsonObject(args) ?? {};
  const candidates = [
    ...preferredConnections,
    ...mcp.names().filter((name) => !preferredConnections.includes(name)),
  ];

  const tried: string[] = [];
  let lastError: string | undefined;

  for (const connection of candidates) {
    if (!mcp.names().includes(connection)) continue;
    tried.push(connection);

    let tools: McpToolInfo[];
    try {
      tools = await mcp.listTools(connection);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }

    const match = tools.find((entry) => toolNameMatches(entry.name, tool));
    if (!match) continue;

    let result: McpCallResult;
    try {
      result = await mcp.callTool(connection, match.name, args);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }

    const text = result.content
      .filter(
        (part): part is { type: "text"; text: string } =>
          part.type === "text" && typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("\n")
      .trim();

    if (result.isError) {
      return {
        ok: false,
        connection,
        tool: match.name,
        callArguments,
        text: text || undefined,
        structuredContent: asJsonObject(result.structuredContent),
        error: text || "MCP tool returned isError",
      };
    }

    return {
      ok: true,
      connection,
      tool: match.name,
      callArguments,
      text: text || undefined,
      structuredContent: asJsonObject(result.structuredContent),
    };
  }

  return {
    ok: false,
    connection: preferredConnections[0] ?? "none",
    tool,
    callArguments,
    error:
      lastError ??
      `No MCP connection exposed tool "${tool}". Tried: ${tried.join(", ") || "(none)"}. Authorize official Google MCP OAuth or connect Gmail/Google Calendar providers that expose the same tool names.`,
  };
}
