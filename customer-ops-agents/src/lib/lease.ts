import { randomUUID } from "node:crypto";
import { LeaseBusyError } from "./errors";
import { sleep } from "./retry";
import { type KvStore, ttlFromNow } from "./store";

export interface Lease {
  resource: string;
  token: string;
  /** Monotonic per resource. Anything that records a decision can store it and reject older fences. */
  fence: number;
  /** Re-check before committing an external write; narrows (doesn't close) the expired-lease window. */
  stillHeld(): Promise<boolean>;
}

export interface LeaseOptions {
  ttlMs?: number;
  /** Total time to wait for the lease before giving up with LeaseBusyError. */
  waitMs?: number;
  now?: () => number;
}

/**
 * Mutual exclusion across concurrent executions, for read-modify-write
 * sequences against providers that have no compare-and-swap of their own
 * (e.g. "find Stripe customer by email, else create").
 *
 * A lease auto-expires after `ttlMs`, so a crashed holder can't wedge the
 * resource. Keep the critical section well under `ttlMs`.
 */
export async function withLease<T>(store: KvStore, resource: string, fn: (lease: Lease) => Promise<T>, opts: LeaseOptions = {}): Promise<T> {
  const { ttlMs = 30_000, waitMs = 10_000, now = Date.now } = opts;
  const pk = `lease#${resource}`;
  const token = randomUUID();
  const deadline = now() + waitMs;

  for (let attempt = 0; ; attempt++) {
    const prev = await store.get(pk);
    const fence = (typeof prev?.fence === "number" ? prev.fence : 0) + 1;
    const acquired = await store.put(
      { pk, token, fence, expiresAt: now() + ttlMs, ttl: ttlFromNow(3600, now()) },
      { kind: "notExistsOrExpired", now: now() },
    );
    if (acquired) {
      const lease: Lease = {
        resource,
        token,
        fence,
        stillHeld: async () => {
          const cur = await store.get(pk);
          return cur?.token === token && typeof cur.expiresAt === "number" && cur.expiresAt > now();
        },
      };
      try {
        return await fn(lease);
      } finally {
        // Only release our own lease — never one a successor acquired after ours expired.
        await store.delete(pk, { kind: "equals", attrs: { token } });
      }
    }
    if (now() >= deadline) throw new LeaseBusyError(`lease ${resource} is held by another worker`);
    await sleep(Math.min(1_000, 50 * 2 ** attempt) * (0.5 + Math.random()));
  }
}
