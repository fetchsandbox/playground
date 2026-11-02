import { describe, expect, it } from "vitest";
import type { KvStore } from "../../src/kit/store";

/**
 * The guarantees the engine relies on from a run store. A new adapter (Firestore, Cloud SQL /
 * Postgres, Snowflake hybrid tables, Redis…) passes these before it holds real runs:
 *
 *   import { kvStoreConformance } from "./conformance/kv-store";
 *   kvStoreConformance("postgres", async () => new PostgresStore(url));
 */
export function kvStoreConformance(name: string, make: () => Promise<KvStore>) {
  describe(`KvStore conformance: ${name}`, () => {
    it("create is put-if-absent and starts at version 1", async () => {
      const s = await make();
      expect(await s.create({ pk: "run#a", value: 1 } as any)).toBe(true);
      expect(await s.create({ pk: "run#a", value: 2 } as any)).toBe(false);
      expect(await s.get("run#a")).toMatchObject({ pk: "run#a", value: 1, version: 1 });
    });

    it("replace is compare-and-swap on version", async () => {
      const s = await make();
      await s.create({ pk: "run#b", n: 0 } as any);
      const v1 = (await s.get("run#b"))!;
      expect(await s.replace({ ...v1, n: 1 })).toBe(true);
      // A second writer still holding version 1 loses.
      expect(await s.replace({ ...v1, n: 99 })).toBe(false);
      expect(await s.get("run#b")).toMatchObject({ n: 1, version: 2 });
      expect(await s.replace({ pk: "run#missing", version: 1 } as any)).toBe(false);
    });

    it("exactly one of many concurrent writers wins each version", async () => {
      const s = await make();
      await s.create({ pk: "run#c", n: 0 } as any);
      const base = (await s.get("run#c"))!;
      const wins = (await Promise.all(Array.from({ length: 8 }, (_, i) => s.replace({ ...base, n: i + 1 })))).filter(Boolean);
      expect(wins).toHaveLength(1);
    });

    it("get returns a copy, delete removes, list filters by prefix", async () => {
      const s = await make();
      await s.create({ pk: "run#d", tags: ["x"] } as any);
      const got = (await s.get("run#d")) as any;
      got.tags.push("mutated");
      expect(((await s.get("run#d")) as any).tags).toEqual(["x"]);
      await s.create({ pk: "audit#d#1" } as any);
      expect((await s.list("run#")).map((i) => i.pk)).toEqual(["run#d"]);
      await s.delete("run#d");
      expect(await s.get("run#d")).toBeUndefined();
    });
  });
}
