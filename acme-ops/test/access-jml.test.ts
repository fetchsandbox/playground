import { describe, expect, it } from "vitest";
import { PRIVILEGED, sodViolations } from "../src/workflows/access-jml";

const NOW = new Date("2026-10-17T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

describe("access-jml policy", () => {
  it("flags segregation-of-duties conflicts and privileged roles", () => {
    expect(sodViolations(["member", "finance-admin", "it-admin"])).toEqual(["finance-admin+it-admin"]);
    expect(sodViolations(["member", "finance-admin"])).toEqual([]);
    expect(PRIVILEGED.has("billing-admin")).toBe(true);
    expect(PRIVILEGED.has("engineer")).toBe(false);
  });
});
