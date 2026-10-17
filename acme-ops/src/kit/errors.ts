// Error taxonomy shared by agents, actions and provider clients.

/** A provider refused or failed a call. `code` is the provider's own error code when it sends one. */
export class ProviderError extends Error {
  override name = "ProviderError";
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Bad input or an impossible request. Retrying cannot help. */
export class FatalError extends Error {
  override name = "FatalError";
}

export function isRetryable(err: unknown): boolean {
  return err instanceof ProviderError && err.retryable;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ProviderError) return `${err.provider} ${err.status} ${err.code}: ${err.message}`;
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Short, stable label for run views and assertions, e.g. "slack:channel_not_found". */
export function errorCode(err: unknown): string {
  if (err instanceof ProviderError) return `${err.provider}:${err.code}`;
  if (err instanceof FatalError) return "fatal";
  if (err instanceof Error && err.name === "TimeoutError") return "timeout";
  return "error";
}
