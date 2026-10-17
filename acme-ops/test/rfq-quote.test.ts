import { describe, expect, it } from "vitest";
import { discountPolicy } from "../src/workflows/rfq-quote";

describe("rfq-quote", () => {
  it("applies the discount policy in code", () => {
    expect(discountPolicy(0)).toEqual({ policy: "auto", applied: 0 });
    expect(discountPolicy(10)).toEqual({ policy: "auto", applied: 10 });
    expect(discountPolicy(10.5)).toEqual({ policy: "approval", applied: 10.5 });
    expect(discountPolicy(30)).toEqual({ policy: "approval", applied: 30 });
    expect(discountPolicy(31)).toEqual({ policy: "declined", applied: 0 });
  });
});
