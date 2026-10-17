import { describe, expect, it } from "vitest";
import { tierFor } from "../src/workflows/collections-credit-hold";
import { decideClaims } from "../src/workflows/distributor-claims";
import { decide } from "../src/workflows/export-screening";
import { nextRenewal } from "../src/workflows/service-renewals";

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

describe("distributor-claims decideClaims()", () => {
  const ledger = {
    customerId: "cus_d",
    currency: "usd",
    invoices: {
      in_paid: { id: "in_paid", customer: "cus_d", status: "paid", amount_due: 24500, currency: "usd", amountPaid: 24500, lines: [] },
      in_lines: { id: "in_lines", customer: "cus_d", status: "paid", amount_due: 9800, currency: "usd", amountPaid: 9800, lines: [{ product: "prod_p", quantity: 2 }] },
    },
    alreadyPaid: ["C-OLD"],
  };
  const prices = { listUnit: { prod_p: { unitAmount: 4900, currency: "usd" } } };
  const claim = (claimId: string, over: object = {}) => ({ claimId, invoiceId: "in_paid", productId: "prod_p", qty: 2, claimedUnitPriceMinor: 4165, endCustomer: "x", ...over });
  const run = (claims: ReturnType<typeof claim>[]) =>
    decideClaims({ distributorEmail: "d@x.co", claims, agreement: { maxDiscountPct: 20 }, financeChannel: "C0FINANCE1" } as never, ledger, prices);

  it("approves within the agreement, caps beyond it, refuses re-submissions", () => {
    const [a, b, c] = run([claim("C-1"), claim("C-2", { claimedUnitPriceMinor: 2450 }), claim("C-OLD")]);
    expect([a!.decision, a!.creditMinor]).toEqual(["approve", 1470]);
    expect([b!.decision, b!.creditMinor]).toEqual(["partial", 1960]);
    expect([c!.decision, c!.reasons]).toEqual(["deny", ["already credited"]]);
  });
  it("checks quantity against invoice lines when present, across claims", () => {
    const [a, b] = run([claim("C-1", { invoiceId: "in_lines", qty: 2 }), claim("C-2", { invoiceId: "in_lines", qty: 1 })]);
    expect(a!.decision).toBe("approve");
    expect(b!.reasons[0]).toMatch(/claims 3 units, invoice has 2/);
  });
  it("denies claims that exceed what was paid when lines are unavailable", () => {
    expect(run([claim("C-1", { qty: 6 })])[0]!.decision).toBe("deny");
  });
});

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

describe("collections tiers", () => {
  it("tiers by days overdue", () => {
    expect([tierFor(7), tierFor(30), tierFor(60)]).toEqual(["reminder", "firm", "final"]);
  });
});
