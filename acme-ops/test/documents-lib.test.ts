import { describe, expect, it } from "vitest";
import { fill, firstMatch, onDate, templateString } from "../src/workflows/lib/documents";

describe("document workflow helpers", () => {
  it("fills placeholders without letting a value add a path segment", () => {
    expect(fill("Legal/{type}/{year}/{counterparty}", { type: "MSA", year: 2026, counterparty: "../../Payroll" })).toBe("Legal/MSA/2026/.. .. Payroll");
    expect(fill("{a}-{b}", { a: "x" })).toBe("x-unknown");
  });

  it("rejects templates with placeholders the workflow doesn't provide", () => {
    const t = templateString(["year", "type"], "folder");
    expect(t.safeParse("Legal/{type}/{year}").success).toBe(true);
    expect(t.safeParse("Legal/{tpye}").error?.issues[0]?.message).toMatch(/unknown placeholder\(s\) tpye/);
  });

  it("first matching rule wins; empty conditions match anything; case-insensitive", () => {
    const rules = [
      { match: { country: ["US"], employmentType: ["full_time"] }, name: "us-ft" },
      { match: { country: ["us"] }, name: "us" },
      { match: {}, name: "default" },
    ];
    expect(firstMatch(rules, { country: "US", employmentType: "FULL_TIME" })?.name).toBe("us-ft");
    expect(firstMatch(rules, { country: "US", employmentType: "contractor" })?.name).toBe("us");
    expect(firstMatch(rules, { country: "DE" })?.name).toBe("default");
  });

  it("date timers are midday UTC", () => {
    expect(onDate("2026-11-02", -7)).toBe("2026-10-26T15:00:00.000Z");
  });
});
