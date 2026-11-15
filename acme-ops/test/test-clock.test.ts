import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestClock } from "../src/kit/test-clock";
import { FileStore, MemoryStore } from "../src/kit/store";

describe("verifier business clock", () => {
  it("persists advances across reconstructed clock and store instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fs-clock-"));
    try {
      const path = join(dir, "state.json");
      const first = await TestClock.open(new FileStore(path), "vr_first");
      const before = first.now();
      await first.advance("vr_first", 7 * 86400);
      const restored = await TestClock.open(new FileStore(path), "vr_first");
      expect(restored.now()).toBe(before + 7 * 86400 * 1000);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("starts at an explicit epoch and never rewinds persisted time on restart", async () => {
    const store = new MemoryStore(), epoch = Date.parse("2026-11-14T12:00:00Z");
    const first = await TestClock.open(store, "vr_epoch", epoch);
    expect(first.now()).toBe(epoch);
    await first.advance("vr_epoch", 0.001);
    const restored = await TestClock.open(store, "vr_epoch", epoch);
    expect(restored.now()).toBe(epoch + 1);
  });
  it.each([NaN, Infinity, -1, 0, 946684799999, 4102444800001, 1.5])("rejects invalid initial epoch %s", async epoch => {
    await expect(TestClock.open(new MemoryStore(), "vr_epoch", epoch)).rejects.toThrow("invalid test clock epoch");
  });
  it("isolates run clocks and preserves concurrent increments through CAS", async () => {
    const store = new MemoryStore();
    const a = await TestClock.open(store, "vr_first");
    const b = await TestClock.open(store, "vr_second");
    const before = a.now(), untouched = b.now();
    const same = await TestClock.open(store, "vr_first");
    await Promise.all([a.advance("vr_first", 1), same.advance("vr_first", 2)]);
    await a.refresh(); await b.refresh();
    expect(a.now()).toBe(before + 3000); expect(b.now()).toBe(untouched);
    await expect(a.advance("vr_second", 1)).rejects.toThrow();
  });
  it.each([-1, 0, NaN, Infinity, true, "10", 367 * 86400])("rejects invalid interval %s", async seconds => {
    const clock = await TestClock.open(new MemoryStore(), "vr_first");
    const before = clock.now();
    await expect(clock.advance("vr_first", seconds)).rejects.toThrow();
    expect(clock.now()).toBe(before);
  });
});
