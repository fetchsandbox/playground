import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consentPropagation, verdict } from "../src/workflows/consent-propagation";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const user = { userId: "U_PREFCENTER" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const input = (over: object = {}) => ({ eventId: "evt_pref_0001", email: "alice@acmecorp.com", occurredAt: at(0), source: "preference_center", changes: [{ purpose: "marketing_email", state: "withdrawn" }, { purpose: "sale_or_share", state: "withdrawn" }], marketingSubscriptionId: "4242", privacyChannel: "C0SUPPORT1", ...over });

describe("verdict", () => {
  it("writes newer events, ignores repeats, refuses stale ones", () => {
    expect(verdict(null, "withdrawn", at(0))).toBe("write");
    expect(verdict(`granted@${at(-5)}`, "withdrawn", at(0))).toBe("write");
    expect(verdict(`withdrawn@${at(-5)}`, "withdrawn", at(0))).toBe("same");
    expect(verdict(`granted@${at(5)}`, "withdrawn", at(0))).toBe("stale");
  });
});

describe("consent-propagation runs", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
    w.state.hubspot.contacts.push({ id: "601", properties: { email: "alice@acmecorp.com" } });
    w.state.hubspot.subscriptions.set("alice@acmecorp.com|4242", "SUBSCRIBED");
    w.state.stripe.customers.push({ id: "cus_alice_eu", email: "alice@acmecorp.com", name: "Alice (EU)", metadata: {} });
  });
  afterEach(() => w.close());

  it("an opt-out reaches HubSpot (property and subscription) and every Stripe customer, then verifies after 15 minutes", async () => {
    const clock = { t: NOW };
    const e = w.engine(consentPropagation, { now: () => clock.t });
    const r = await e.handle({ action: "start", runId: "c", input: input(), requestedBy: user });
    expect(r.body.output).toMatchObject({ mode: "propagate", contact: "601", customers: 2 });
    expect(w.state.hubspot.contacts[0].properties).toMatchObject({ acme_consent_marketing_email: `withdrawn@${at(0)}`, acme_consent_sale_or_share: `withdrawn@${at(0)}`, acme_consent_last_event: "evt_pref_0001" });
    expect(w.state.hubspot.subscriptions.get("alice@acmecorp.com|4242")).toBe("NOT_SUBSCRIBED");
    expect(w.state.stripe.customers.filter((c: any) => c.email === "alice@acmecorp.com").map((c: any) => c.metadata?.acme_consent_sale_or_share)).toEqual([`withdrawn@${at(0)}`, `withdrawn@${at(0)}`]);
    expect(action(r.body, "consent.verify").status).toBe("scheduled");
    clock.t = NOW + 15 * 60_000 + 1;
    await e.handle({ action: "tick" });
    const s = (await e.handle({ action: "status", runId: "c" })).body;
    expect(action(s, "consent.verify")).toMatchObject({ status: "applied", ref: "verified" });
    expect(s.phase).toBe("DONE");
  });

  it("a stale event never overwrites a newer choice", async () => {
    w.state.hubspot.contacts[0].properties.acme_consent_marketing_email = `granted@${at(10)}`;
    w.state.hubspot.contacts[0].properties.acme_consent_sale_or_share = `granted@${at(10)}`;
    const r = await w.engine(consentPropagation, { now: () => NOW }).handle({ action: "start", runId: "c", input: input(), requestedBy: user });
    expect(action(r.body, "hubspot.consent:601")).toMatchObject({ status: "skipped", detail: { reason: "newer consent on record for marketing_email, sale_or_share" } });
    expect(w.state.hubspot.contacts[0].properties.acme_consent_marketing_email).toBe(`granted@${at(10)}`);
  });

  it("a replayed event changes nothing", async () => {
    const e = w.engine(consentPropagation, { now: () => NOW });
    await e.handle({ action: "start", runId: "c1", input: input(), requestedBy: user });
    const r = await e.handle({ action: "start", runId: "c2", input: input(), requestedBy: user });
    expect(r.body.actions.filter((a: any) => a.kind !== "consent.verify").map((a: any) => a.status)).toEqual(["skipped", "skipped", "skipped", "skipped"]);
  });

  it("a write overwritten by another integration is re-applied once at verification", async () => {
    const clock = { t: NOW };
    const e = w.engine(consentPropagation, { now: () => clock.t });
    await e.handle({ action: "start", runId: "c", input: input({ changes: [{ purpose: "profiling", state: "withdrawn" }] }), requestedBy: user });
    w.state.hubspot.contacts[0].properties.acme_consent_profiling = "";
    clock.t = NOW + 15 * 60_000 + 1;
    await e.handle({ action: "tick" });
    const s = (await e.handle({ action: "status", runId: "c" })).body;
    expect(action(s, "consent.verify")).toMatchObject({ status: "applied", ref: "verified", detail: { reapplied: ["HubSpot 601"] } });
    expect(w.state.hubspot.contacts[0].properties.acme_consent_profiling).toBe(`withdrawn@${at(0)}`);
  });

  it("a Stripe write that keeps failing is escalated at verification", async () => {
    const clock = { t: NOW };
    w.faults.push({ method: "POST", path: /^\/v1\/customers\/cus_alice_eu$/, status: 500, body: { error: { type: "api_error" } }, times: 99 });
    const e = w.engine(consentPropagation, { now: () => clock.t });
    await e.handle({ action: "start", runId: "c", input: input(), requestedBy: user });
    clock.t = NOW + 15 * 60_000 + 1;
    await e.handle({ action: "tick" });
    const s = (await e.handle({ action: "status", runId: "c" })).body;
    expect(action(s, "consent.verify")).toMatchObject({ ref: "mismatch" });
    expect(w.state.slack.messages.at(-1).text).toMatch(/not in effect everywhere: stripe\.consent:cus_alice_eu \(write failed\); Stripe cus_alice_eu/);
  });

  it("when HubSpot can't be read, Stripe is still updated and privacy-ops is told", async () => {
    w.faults.push({ method: "POST", path: /^\/crm\/v3\/objects\/contacts\/search$/, status: 429, body: {} });
    const r = await w.engine(consentPropagation, { now: () => NOW }).handle({ action: "start", runId: "c", input: input(), requestedBy: user });
    expect(r.body.output.mode).toBe("partial");
    expect(action(r.body, "stripe.consent:cus_alice").status).toBe("applied");
    expect(action(r.body, "slack.post_consent").status).toBe("applied");
  });
});
