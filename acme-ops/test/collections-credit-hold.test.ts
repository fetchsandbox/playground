import { describe, expect, it } from "vitest";
import { tierFor } from "../src/workflows/collections-credit-hold";

const classified = { items: [{ productId: "prod_a", eccn: "EAR99", itar: false, found: true }] };

describe("collections tiers", () => {
  it("tiers by days overdue", () => {
    expect([tierFor(7), tierFor(30), tierFor(60)]).toEqual(["reminder", "firm", "final"]);
  });
});
