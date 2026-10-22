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

/**
 * A provider answered in a shape its own published API reference doesn't allow
 * (a field of the wrong type, an unwrapped object, a missing documented field).
 * Clients follow the vendor's spec and never adapt to such answers: the run
 * fails closed and the deviation is visible in the run record and logs.
 */
export class SpecDeviation extends ProviderError {
  override name = "SpecDeviation";
  constructor(provider: string, what: string) {
    super(provider, 0, "spec_deviation", false, `${provider} response deviates from its published API: ${what}`);
  }
}

/**
 * Defensive checks that real-spec code keeps (e.g. re-applying a documented
 * filter) report when they fire, so a provider ignoring its own spec is logged
 * rather than silently absorbed.
 */
export function specWarning(provider: string, what: string): void {
  console.log(JSON.stringify({ level: "warn", msg: "provider spec deviation", provider, deviation: what, at: new Date().toISOString() }));
}

/** Bad input or an impossible request. Retrying cannot help. */
export class FatalError extends Error {
  override name = "FatalError";
}

/** Kit v2: the action decided at run time that it doesn't apply (e.g. its precondition was rejected). Recorded as skipped. */
export class SkipAction extends Error {
  override name = "SkipAction";
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
