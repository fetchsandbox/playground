import { describe, expect, it } from "vitest";
import { fieldServiceDispatch } from "../src/workflows/field-service-dispatch";

const alarm = {
  alarm: { id: "ALM-1", site: "Substation 7", asset: "TX-12 monitor", severity: "critical" },
  account: { email: "ops@utility.test" },
  sitePhone: "+15125550100",
  technicianCalendars: ["tech1@acme.test"],
  dispatchChannel: "C0FIELD001",
};

describe("field-service-dispatch input and gating", () => {
  it("accepts a complete alarm and rejects a non-E.164 site phone", () => {
    expect(fieldServiceDispatch.input.safeParse(alarm).success).toBe(true);
    expect(fieldServiceDispatch.input.safeParse({ ...alarm, sitePhone: "512-555-0100" }).success).toBe(false);
    expect(fieldServiceDispatch.input.safeParse({ ...alarm, technicianCalendars: [] }).success).toBe(false);
  });

  it("can gate the technician booking; site text and work order are automatic", () => {
    const gate = Object.fromEntries(fieldServiceDispatch.catalog.map((c) => [c.kind, c.gate]));
    expect(gate).toMatchObject({ "calendar.book_technician": "approval", "twilio.notify_site": "auto", "asana.create_work_order": "auto" });
  });
});
