import { describe, expect, it } from "vitest";
import { pcnEolNotice } from "../src/workflows/pcn-eol-notice";

const change = {
  repo: "acme/plm",
  productId: "prod_SaaS_ProPlan",
  kind: "end_of_life",
  title: "EOL: Pro monitoring v1",
  summary: "Replaced by v2.",
  effectiveDate: "2027-03-31",
  lastTimeBuy: "2026-12-31",
  notifyChannel: "C0GENERAL01",
};

describe("pcn-eol-notice input and gating", () => {
  it("accepts a change record and rejects bad repos, products and dates", () => {
    expect(pcnEolNotice.input.safeParse(change).success).toBe(true);
    expect(pcnEolNotice.input.safeParse({ ...change, repo: "plm" }).success).toBe(false);
    expect(pcnEolNotice.input.safeParse({ ...change, productId: "pro" }).success).toBe(false);
    expect(pcnEolNotice.input.safeParse({ ...change, effectiveDate: "next spring" }).success).toBe(false);
  });

  it("customer notices and marking customers notified need approval", () => {
    const gated = pcnEolNotice.catalog.filter((c) => c.gate === "approval").map((c) => c.kind).sort();
    expect(gated).toEqual(["github.mark_customers_notified", "gmail.draft_customer_notice"]);
  });
});
