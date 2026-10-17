import { describe, expect, it } from "vitest";
import { orderState } from "../src/workflows/order-status";

describe("order-status", () => {
  it("derives the order state from the fulfillment task", () => {
    expect(orderState(undefined, "2026-10-17")).toBe("unknown");
    expect(orderState({ scheduled: false, shipped: false }, "2026-10-17")).toBe("unscheduled");
    expect(orderState({ scheduled: true, shipped: true, promisedOn: "2025-01-01" }, "2026-10-17")).toBe("shipped");
    expect(orderState({ scheduled: true, shipped: false, promisedOn: "2026-10-16" }, "2026-10-17")).toBe("late");
    expect(orderState({ scheduled: true, shipped: false, promisedOn: "2026-10-17" }, "2026-10-17")).toBe("on_time");
  });
});
