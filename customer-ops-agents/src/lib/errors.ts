// Error taxonomy. Step Functions matches Retry/Catch rules on `error.name`
// (Lambda reports it as `errorType`), so these names are part of the
// contract with infra/stack.ts — rename them in both places or neither.

/** Transient: safe to retry the whole step (rate limit, 5xx, lock busy). */
export class RetryableError extends Error {
  override name = "RetryableError";
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Another worker holds the lease on this resource right now. */
export class LeaseBusyError extends RetryableError {
  override name = "LeaseBusyError";
}

/** Another worker is mid-way through this exact side effect. */
export class EffectInProgressError extends RetryableError {
  override name = "EffectInProgressError";
}

/** Permanent: bad input, refusal, 4xx. Retrying cannot help. */
export class FatalError extends Error {
  override name = "FatalError";
}

export class HttpError extends Error {
  override name = "HttpError";
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 500)}`);
  }
}

export function isRetryable(err: unknown): boolean {
  return err instanceof RetryableError;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
