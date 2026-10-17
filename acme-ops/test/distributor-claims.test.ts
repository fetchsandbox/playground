import { describe, expect, it } from "vitest";
import { decideClaims } from "../src/workflows/distributor-claims";

const classified = { items: [{ productId: "prod_a", eccn: "EAR99", itar: false, found: true }] };

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
