import { describe, expect, it } from "vitest";
import { warrantyEnd } from "../src/workflows/returns-warranty";

describe("returns-warranty", () => {
  it("warranty runs 24 months from the invoice date", () => {
    expect(warrantyEnd(Date.parse("2025-01-01T00:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});
