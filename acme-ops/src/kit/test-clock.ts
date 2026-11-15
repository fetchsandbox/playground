import type { KvStore } from "./store";

/** Explicit verifier-only business clock, using the runtime's existing CAS store. */
export class TestClock {
  private current = 0;
  private constructor(private store: KvStore, readonly runId: string) {}
  static async open(store: KvStore, runId: string, initialEpochMs = Date.now()): Promise<TestClock> {
    if (!/^vr_[a-zA-Z0-9]+$/.test(runId)) throw new Error("invalid test clock run identity");
    if (!Number.isSafeInteger(initialEpochMs) || initialEpochMs < 946684800000 || initialEpochMs > 4102444800000) throw new Error("invalid test clock epoch");
    const clock = new TestClock(store, runId);
    await store.create({ pk: clock.key, now: initialEpochMs });
    await clock.refresh();
    return clock;
  }
  private get key() { return `test-clock#${this.runId}`; }
  now = () => this.current;
  async refresh() {
    const row = await this.store.get(this.key);
    if (!row || typeof row.now !== "number" || !Number.isFinite(row.now)) throw new Error("test clock storage unavailable");
    this.current = row.now;
    return { run_id: this.runId, now_epoch_seconds: this.current / 1000 };
  }
  async advance(runId: unknown, seconds: unknown) {
    if (runId !== this.runId || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0 || seconds > 366 * 86400) throw new Error("invalid test clock advance");
    for (let n = 0; n < 5; n++) {
      const row = await this.store.get(this.key);
      if (!row || typeof row.now !== "number") throw new Error("test clock storage unavailable");
      if (await this.store.replace({ ...row, now: row.now + seconds * 1000 })) return this.refresh();
    }
    throw new Error("test clock contention; advance not acknowledged");
  }
}
