import { describe, expect, it } from "vitest";
import { decide } from "../src/workflows/export-screening";

const classified = { items: [{ productId: "prod_a", eccn: "EAR99", itar: false, found: true }] };

describe("export-screening decide()", () => {
  it("clears only when screening ran clean, items are classified and the destination is allowed", () => {
    expect(decide({ shipToCountry: "DE", endUse: "utility monitoring" }, classified, { hits: [] }, true)).toEqual({ status: "clear", reasons: [] });
  });
  it("holds when screening is unavailable (fail-safe)", () => {
    expect(decide({ shipToCountry: "DE", endUse: "x" }, classified, undefined, false).reasons).toEqual(["restricted-party screening unavailable"]);
  });
  it("holds on hits, embargoes, ITAR, unclassified items and military end use", () => {
    const d = decide(
      { shipToCountry: "IR", endUse: "missile guidance" },
      { items: [{ productId: "prod_b", itar: true, found: true }, { productId: "prod_c", itar: false, found: true }] },
      { hits: [{ name: "Bad Co", source: "SDN" }] },
      true,
    );
    expect(d.status).toBe("hold");
    expect(d.reasons).toHaveLength(5);
  });
});
