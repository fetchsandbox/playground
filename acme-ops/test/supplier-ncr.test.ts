import { describe, expect, it } from "vitest";
import { holdReasons } from "../src/workflows/supplier-ncr";

const NOW = new Date("2026-10-17T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

describe("supplier-ncr hold policy", () => {
  it("proposes a hold for critical defects, high reject rates or repeat suppliers", () => {
    expect(holdReasons({ severity: "major", qtyInspected: 200, qtyRejected: 2 }, 0)).toEqual([]);
    expect(holdReasons({ severity: "critical", qtyInspected: 200, qtyRejected: 2 }, 0)).toEqual(["critical defect"]);
    expect(holdReasons({ severity: "minor", qtyInspected: 100, qtyRejected: 10 }, 0)).toEqual(["reject rate 10%"]);
    expect(holdReasons({ severity: "minor", qtyInspected: 100, qtyRejected: 1 }, 2)).toEqual(["2 open CAPAs"]);
  });
});
