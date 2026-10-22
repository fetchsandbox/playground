import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classify, deliveryException } from "../src/workflows/delivery-exception";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const DAY = 86_400_000;
const user = { userId: "U_EASYPOST_WEBHOOK" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const input = (over: object = {}) => ({ eventId: "evt_trk_000001", trackerId: "trk_1", orderId: "9001", opsChannel: "C0ONBOARD1", approvers: ["U_LEAD"], ...over });
const scan = (daysAgo: number, status = "in_transit") => ({ datetime: new Date(NOW - daysAgo * DAY).toISOString(), status, message: "Departed facility" });

describe("classify", () => {
  it("reads delays, stuck and lost shipments from the scans", () => {
    expect(classify({ status: "in_transit", tracking_details: [scan(1)] }, NOW)).toBe("on_track");
    expect(classify({ status: "in_transit", est_delivery_date: new Date(NOW - DAY).toISOString(), tracking_details: [scan(1)] }, NOW)).toBe("delayed");
    expect(classify({ status: "in_transit", tracking_details: [scan(4)] }, NOW)).toBe("stuck");
    expect(classify({ status: "in_transit", tracking_details: [scan(8)] }, NOW)).toBe("lost");
    expect(classify({ status: "return_to_sender", tracking_details: [scan(1)] }, NOW)).toBe("returned");
  });
});

describe("delivery-exception runs", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
    w.state.shopify.orders.push({ id: 9001, name: "#1042", email: "kim@example.com", total_price: "64.00", tags: "", line_items: [{ variant_id: 1001, quantity: 2 }] });
  });
  afterEach(() => w.close());

  it("a stuck parcel: customer told first; delivered within 48h → ticket solved, no replacement", async () => {
    w.state.easypost.trackers.push({ id: "trk_1", status: "in_transit", carrier: "UPS", tracking_code: "1Z1", tracking_details: [scan(4)] });
    const clock = { t: NOW };
    const e = w.engine(deliveryException, { now: () => clock.t });
    const r = await e.handle({ action: "start", runId: "d", input: input(), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "stuck", order: "#1042", replaced: false });
    const ticket = w.state.zendesk.tickets[0];
    expect(ticket).toMatchObject({ external_id: "shipment-trk_1", status: "pending" });
    expect(w.state.zendesk.comments.find((c: any) => c.public)?.body).toMatch(/running late with UPS/);
    w.state.easypost.trackers[0].status = "delivered";
    clock.t = NOW + 48 * 3_600_000 + 1;
    await e.handle({ action: "tick" });
    expect(ticket.status).toBe("solved");
    expect(w.state.shopify.drafts).toHaveLength(0);
  });

  it("still not delivered after 48h: a free replacement is sent once", async () => {
    w.state.easypost.trackers.push({ id: "trk_1", status: "in_transit", carrier: "UPS", tracking_code: "1Z1", tracking_details: [scan(4)] });
    const clock = { t: NOW };
    const e = w.engine(deliveryException, { now: () => clock.t });
    await e.handle({ action: "start", runId: "d", input: input(), requestedBy: user });
    clock.t = NOW + 49 * 3_600_000;
    await e.handle({ action: "tick" });
    expect(w.state.shopify.drafts).toEqual([expect.objectContaining({ applied_discount: expect.objectContaining({ value: "100.0" }), line_items: [{ variant_id: 1001, quantity: 2 }] })]);
    expect(w.state.shopify.orders[0].tags).toContain("replaced-trk_1");
    // The webhook is delivered again: no second ticket, no second replacement.
    const again = await e.handle({ action: "start", runId: "d2", input: input({ eventId: "evt_trk_000002" }), requestedBy: user });
    expect(again.body.output.replaced).toBe(true);
    expect(again.body.actions).toEqual([]);
    expect(w.state.zendesk.tickets).toHaveLength(1);
  });

  it("a lost parcel is replaced at once; an expensive one waits for a lead", async () => {
    w.state.easypost.trackers.push({ id: "trk_1", status: "in_transit", carrier: "UPS", tracking_code: "1Z1", tracking_details: [scan(9)] });
    w.state.shopify.orders[0].total_price = "640.00";
    const e = w.engine(deliveryException, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "d", input: input(), requestedBy: user });
    expect(action(r.body, "shopify.replacement:trk_1").status).toBe("pending_approval");
    expect(w.state.zendesk.comments.find((c: any) => c.public)?.body).toMatch(/sending a replacement at no cost/);
    await e.handle({ action: "decide", runId: "d", decision: "approve", userId: "U_LEAD" });
    expect(w.state.shopify.drafts).toHaveLength(1);
  });

  it("an on-track shipment does nothing; an unreadable tracker is reported", async () => {
    w.state.easypost.trackers.push({ id: "trk_1", status: "in_transit", carrier: "UPS", tracking_code: "1Z1", tracking_details: [scan(1)] });
    const ok = await w.engine(deliveryException, { now: () => NOW }).handle({ action: "start", runId: "d", input: input(), requestedBy: user });
    expect(ok.body.actions).toEqual([]);
    const bad = await w.engine(deliveryException, { now: () => NOW }).handle({ action: "start", runId: "d3", input: input({ trackerId: "trk_missing" }), requestedBy: user });
    expect(bad.body.output).toEqual({ mode: "blocked" });
    expect(w.state.slack.messages[0].text).toMatch(/could not be read/);
  });
});
