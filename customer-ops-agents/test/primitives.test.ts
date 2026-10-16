import { describe, expect, it } from "vitest";
import { EffectInProgressError, LeaseBusyError, RetryableError } from "../src/lib/errors";
import { once } from "../src/lib/idempotency";
import { withLease } from "../src/lib/lease";
import { sleep } from "../src/lib/retry";
import { signSlackBody, verifySlackSignature } from "../src/lib/slack-verify";
import { MemoryStore } from "../src/lib/store";

describe("once() — idempotent side effects", () => {
  it("runs the effect exactly once under 25 concurrent callers", async () => {
    const store = new MemoryStore();
    let calls = 0;
    const effect = async () => {
      calls++;
      await sleep(20);
      return "sent";
    };
    const results = await Promise.allSettled(Array.from({ length: 25 }, () => once(store, "email:1", effect)));
    expect(calls).toBe(1);
    const ok = results.filter((r) => r.status === "fulfilled");
    const busy = results.filter((r) => r.status === "rejected");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    // Losers that arrived mid-flight are told to retry later, never to re-run.
    for (const r of busy) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(EffectInProgressError);
    // After completion every caller gets the cached result without re-running.
    await expect(once(store, "email:1", effect)).resolves.toBe("sent");
    expect(calls).toBe(1);
  });

  it("releases the claim when the effect fails so a retry can succeed", async () => {
    const store = new MemoryStore();
    let calls = 0;
    const flaky = async () => {
      if (++calls === 1) throw new RetryableError("503");
      return calls;
    };
    await expect(once(store, "k", flaky)).rejects.toThrow("503");
    await expect(once(store, "k", flaky)).resolves.toBe(2);
    await expect(once(store, "k", flaky)).resolves.toBe(2);
  });

  it("lets a new worker take over a stale claim from a crashed worker", async () => {
    const store = new MemoryStore();
    let clock = 1_000_000;
    await store.put({ pk: "effect#k", status: "PENDING", owner: "dead-worker", expiresAt: clock + 100 });
    clock += 1_000;
    await expect(once(store, "k", async () => "recovered", { now: () => clock })).resolves.toBe("recovered");
  });
});

describe("withLease() — mutual exclusion", () => {
  it("never lets two critical sections overlap", async () => {
    const store = new MemoryStore();
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withLease(store, "stripe-customer#a@b.c", async () => {
          maxInside = Math.max(maxInside, ++inside);
          await sleep(5);
          inside--;
        }),
      ),
    );
    expect(maxInside).toBe(1);
  });

  it("gives up with LeaseBusyError (retryable) when the holder doesn't release in time", async () => {
    const store = new MemoryStore();
    const holder = withLease(store, "r", () => sleep(300));
    await sleep(10);
    await expect(withLease(store, "r", async () => 1, { waitMs: 50 })).rejects.toBeInstanceOf(LeaseBusyError);
    await holder;
  });

  it("issues increasing fencing tokens and doesn't let an expired holder release its successor's lease", async () => {
    const store = new MemoryStore();
    let clock = 0;
    const now = () => clock;
    const fences: number[] = [];
    const slow = withLease(store, "r", async (l) => {
      fences.push(l.fence);
      clock += 60_000; // we stalled past our TTL…
      await withLease(store, "r", async (l2) => {
        fences.push(l2.fence); // …and a successor acquired it
        expect(await l.stillHeld()).toBe(false);
      }, { now });
    }, { now, ttlMs: 30_000 });
    await slow;
    expect(fences).toEqual([1, 2]);
  });
});

describe("Slack signature verification", () => {
  const secret = "8f742231b10e8888abcd99yyyzzz85a5";
  const body = "token=x&team_id=T1&text=hello";
  const ts = 1_760_000_000;

  it("accepts a valid signature", () => {
    expect(verifySlackSignature({ signingSecret: secret, rawBody: body, timestamp: String(ts), signature: signSlackBody(secret, body, ts), nowSeconds: ts + 5 })).toBe(true);
  });
  it("rejects a tampered body", () => {
    expect(verifySlackSignature({ signingSecret: secret, rawBody: `${body}&x=1`, timestamp: String(ts), signature: signSlackBody(secret, body, ts), nowSeconds: ts })).toBe(false);
  });
  it("rejects replays older than 5 minutes", () => {
    expect(verifySlackSignature({ signingSecret: secret, rawBody: body, timestamp: String(ts), signature: signSlackBody(secret, body, ts), nowSeconds: ts + 301 })).toBe(false);
  });
});
