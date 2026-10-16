import { FatalError, HttpError, RetryableError, isRetryable } from "./errors";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  /** Decide whether `err` is worth another attempt. Defaults to RetryableError. */
  shouldRetry?: (err: unknown) => boolean;
}

/**
 * In-process retry with full-jitter exponential backoff. Honours a provider's
 * Retry-After when the error carries one. Keep `retries` small: the run
 * engine owns step-level retries, this only smooths over blips inside one
 * provider call.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 3, baseMs = 250, maxMs = 8_000, shouldRetry = isRetryable } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries || !shouldRetry(err)) throw err;
      const hinted = err instanceof RetryableError ? err.retryAfterMs : undefined;
      const backoff = Math.random() * Math.min(maxMs, baseMs * 2 ** attempt);
      await sleep(Math.min(maxMs, hinted ?? backoff));
    }
  }
}

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/**
 * fetch() → parsed JSON, with the error mapping every provider shares:
 *   429 / 5xx / network  → RetryableError (with Retry-After if present)
 *   other non-2xx        → HttpError (callers may special-case e.g. 409)
 */
export async function httpJson<T = unknown>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 15_000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new RetryableError(`network error calling ${url}: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (res.status === 429 || res.status >= 500) {
    throw new RetryableError(`HTTP ${res.status} from ${url}`, retryAfterMs(res));
  }
  if (!res.ok) throw new HttpError(res.status, text, url);
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new FatalError(`non-JSON response from ${url}`);
  }
}
