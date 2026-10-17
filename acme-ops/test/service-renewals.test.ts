import { describe, expect, it } from "vitest";
import { nextRenewal } from "../src/workflows/service-renewals";

const classified = { items: [{ productId: "prod_a", eccn: "EAR99", itar: false, found: true }] };

describe("service-renewals nextRenewal()", () => {
  const now = Date.parse("2026-10-17T00:00:00Z");
  it("uses a real future period end", () => {
    expect(nextRenewal({ current_period_end: Date.parse("2026-11-01T00:00:00Z") / 1000 }, "month", 1, now)).toBe(Date.parse("2026-11-01T00:00:00Z"));
  });
  it("otherwise advances the start date by whole intervals", () => {
    expect(new Date(nextRenewal({ created: "2024-09-01T10:05:00Z" }, "month", 1, now)!).toISOString()).toBe("2026-11-01T10:05:00.000Z");
    expect(new Date(nextRenewal({ created: "2024-03-15T00:00:00Z", current_period_end: 77 }, "year", 1, now)!).toISOString()).toBe("2027-03-15T00:00:00.000Z");
  });
});
