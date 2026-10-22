import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { crmBillingSync, diff, mrrOf } from "../src/workflows/crm-billing-sync";
import { NOW, addSub, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const user = { userId: "U_REVOPS" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const input = (over: object = {}) => ({ syncId: "SYNC-2026-10-14T12", segment: "smb-eu", revopsChannel: "C0FINANCE1", ...over });
const cus = (id: string, email: string) => ({ id, email, name: id, metadata: { acme_segment: "smb-eu" } });

describe("mrrOf and diff", () => {
  it("normalizes annual prices to monthly and reports churn", () => {
    const sub = (status: string, unit: number, interval: string, quantity = 1) => ({ id: "s", customer: "c", status, items: { data: [{ price: { id: `p_${interval}`, active: true, currency: "eur", unit_amount: unit, recurring: { interval } }, quantity }] } });
    expect(mrrOf([sub("active", 4900, "month", 3), sub("active", 120000, "year")])).toEqual({ plan: "p_month+p_year", mrr: 24700, status: "active" });
    expect(mrrOf([sub("canceled", 4900, "month")])).toEqual({ plan: "none", mrr: 0, status: "churned" });
  });
  it("never overwrites a contact linked to another customer", () => {
    const billing = { customerId: "cus_1", email: "a@x", plan: "p", mrr: 1, status: "active" };
    expect(diff([{ billing, contactId: "9", linkedTo: "cus_2", current: {} }])).toEqual([{ kind: "conflict", customerId: "cus_1", contactId: "9", linkedTo: "cus_2" }]);
    expect(diff([{ billing, contactId: null, linkedTo: null, current: {} }])[0]!.kind).toBe("unmatched");
  });
});

describe("crm-billing-sync runs", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
    w.state.stripe.customers.push(cus("cus_s1", "one@smb.example"), cus("cus_s2", "two@smb.example"), cus("cus_s3", "three@smb.example"), cus("cus_s4", "four@smb.example"));
    addSub(w.state as any, "cus_s1", "price_pro_monthly", "active", 2);
    addSub(w.state as any, "cus_s2", "price_pro_monthly", "past_due");
    w.state.hubspot.contacts.push(
      { id: "701", properties: { email: "one@smb.example" } },
      { id: "702", properties: { email: "two@smb.example", acme_stripe_customer_id: "cus_s2", acme_plan: "price_pro_monthly", acme_mrr: "4900", acme_billing_status: "past_due" } },
      { id: "703", properties: { email: "three@smb.example", acme_stripe_customer_id: "cus_other" } },
    );
  });
  afterEach(() => w.close());

  it("links and fills new matches, leaves in-sync contacts and conflicts alone", async () => {
    const r = await w.engine(crmBillingSync, { now: () => NOW }).handle({ action: "start", runId: "s", input: input(), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "sync", customers: 4, writes: 1, inSync: 1, unmatched: 1, conflicts: 1 });
    expect(w.state.hubspot.contacts[0].properties).toMatchObject({ acme_stripe_customer_id: "cus_s1", acme_plan: "price_pro_monthly", acme_mrr: "9800", acme_billing_status: "active" });
    expect(w.state.hubspot.contacts[2].properties.acme_stripe_customer_id).toBe("cus_other");
    expect(w.state.slack.messages.at(-1).text).toMatch(/Conflicts \(not written\): cus_s3 → contact 703 \(linked to cus_other\)/);
  });

  it("a contact relinked between read and write is skipped", async () => {
    const e = w.engine(crmBillingSync, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "s", input: input({ maxAutoWrites: 0 }), requestedBy: user });
    expect(action(r.body, "hubspot.sync:cus_s1").status).toBe("pending_approval");
    w.state.hubspot.contacts[0].properties.acme_stripe_customer_id = "cus_elsewhere";
    const d = await e.handle({ action: "decide", runId: "s", decision: "approve", userId: "U_REVOPS_LEAD" });
    expect(action(d.body, "hubspot.sync:cus_s1")).toMatchObject({ status: "skipped", detail: { reason: "contact is now linked to cus_elsewhere" } });
  });

  it("a run that would change most of the segment waits for approval on every write", async () => {
    for (let i = 0; i < 25; i++) {
      w.state.stripe.customers.push(cus(`cus_m${i}`, `m${i}@smb.example`));
      w.state.hubspot.contacts.push({ id: String(800 + i), properties: { email: `m${i}@smb.example`, acme_stripe_customer_id: `cus_m${i}`, acme_plan: "price_pro_monthly", acme_mrr: "4900", acme_billing_status: "active" } });
    }
    // Billing now shows none of them subscribed (an outage or bad import looks like this).
    const r = await w.engine(crmBillingSync, { now: () => NOW }).handle({ action: "start", runId: "s", input: input(), requestedBy: user });
    const syncs = r.body.actions.filter((a: any) => a.kind === "hubspot.sync");
    expect(syncs.length).toBe(26);
    expect(syncs.every((a: any) => a.status === "pending_approval")).toBe(true);
    expect(w.state.slack.messages.at(-1).text).toMatch(/would change 25 of 28 linked contacts at once/);
  });

  it("a re-run writes nothing", async () => {
    const e = w.engine(crmBillingSync, { now: () => NOW });
    await e.handle({ action: "start", runId: "s1", input: input(), requestedBy: user });
    const r = await e.handle({ action: "start", runId: "s2", input: input(), requestedBy: user });
    expect(r.body.output.writes).toBe(0);
  });

  it("when billing can't be read nothing is written", async () => {
    w.faults.push({ method: "GET", path: /^\/v1\/customers$/, status: 500, body: { error: { type: "api_error" } } });
    const r = await w.engine(crmBillingSync, { now: () => NOW }).handle({ action: "start", runId: "s", input: input(), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "blocked" });
    expect(r.body.actions.map((a: any) => a.kind)).toEqual(["slack.post_sync"]);
  });
});
