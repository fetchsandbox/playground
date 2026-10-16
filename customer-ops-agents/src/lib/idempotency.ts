import { randomUUID } from "node:crypto";
import { EffectInProgressError } from "./errors";
import { type KvStore, ttlFromNow } from "./store";

const DONE = Number.MAX_SAFE_INTEGER; // a completed effect never "expires" as a claim

export interface OnceOptions {
  /**
   * How long a claim is honoured before another worker may take over. Must
   * exceed the effect's worst-case runtime, or two workers can both run it.
   */
  claimMs?: number;
  /** How long the cached result is kept (DynamoDB TTL). */
  retainSeconds?: number;
  now?: () => number;
}

/**
 * Run a side effect at most once per `key`, across Lambda retries, Step
 * Functions retries, and concurrent duplicate executions.
 *
 *   1. Claim `effect#key` with a conditional put (absent, or a stale claim).
 *   2. Winner runs `fn`, then stores the result as COMPLETED.
 *   3. Losers either return the cached result, or — if the winner is still
 *      running — throw EffectInProgressError so Step Functions retries later.
 *   4. If `fn` throws, the claim is released so a retry can try again.
 *
 * Caveat: if the process dies *after* the provider accepted the write but
 * *before* step 2, the effect may repeat once the claim goes stale. Pass the
 * same `key` to providers that support native idempotency keys (Stripe) and
 * add a reconciliation check for those that don't (see Gmail sendOnce).
 */
export async function once<T>(store: KvStore, key: string, fn: () => Promise<T>, opts: OnceOptions = {}): Promise<T> {
  const { claimMs = 120_000, retainSeconds = 14 * 86_400, now = Date.now } = opts;
  const pk = `effect#${key}`;
  const owner = randomUUID();

  const claimed = await store.put(
    { pk, status: "PENDING", owner, expiresAt: now() + claimMs, ttl: ttlFromNow(retainSeconds, now()) },
    { kind: "notExistsOrExpired", now: now() },
  );

  if (!claimed) {
    const existing = await store.get(pk);
    if (existing?.status === "COMPLETED") return existing.result as T;
    throw new EffectInProgressError(`effect ${key} is being performed by another worker`);
  }

  let result: T;
  try {
    result = await fn();
  } catch (err) {
    await store.delete(pk, { kind: "equals", attrs: { owner, status: "PENDING" } });
    throw err;
  }

  // Fenced by `owner`: if our claim went stale and someone else took over,
  // don't clobber their record. The effect already happened, so return ours.
  await store.update(
    pk,
    { status: "COMPLETED", result: result === undefined ? null : result, expiresAt: DONE, completedAt: now() },
    { kind: "equals", attrs: { owner, status: "PENDING" } },
  );
  return result;
}
