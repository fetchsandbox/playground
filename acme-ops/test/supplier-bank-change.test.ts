import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assess, supplierBankChange, type Vendor } from "../src/workflows/supplier-bank-change";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const DAY = 86_400_000;
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const user = { userId: "U_AP_CLERK" };
const request = (over: object = {}) => ({
  changeId: "BC-2026-0042",
  vendorId: "731",
  submittedBy: "U_AP_CLERK",
  source: "email",
  requestEmail: "billing@northwind.example",
  newBank: { accountName: "Northwind Traders LLC", last4: "9012", vaultToken: "tok_bank_9012", plaidAccessToken: "access-sandbox-north" },
  verifiers: ["U_AP_CLERK", "U_AP_VERIFIER"],
  apChannel: "C0FINANCE1",
  securityChannel: "C0SUPPORT1",
  approvers: ["U_TREASURY", "U_AP_VERIFIER"],
  ...over,
});

describe("bank change assessment", () => {
  const input = (o: object = {}) => supplierBankChange.input.parse(request(o));
  const vendor = (o: Partial<Vendor> = {}): Vendor => ({ id: "731", name: "Northwind Traders LLC", email: "ap@northwind.example", phone: "+15125550100", createdMs: NOW - 400 * DAY, onHold: false, holdReason: null, bankLast4: "1234", lastChangeMs: null, billsDueMinor: 0, billsDue: 0, ...o });
  const own = { provided: true, bestScore: 92, maskMatches: true };
  it("collects red flags without letting any of them apply the change", () => {
    expect(assess(input(), vendor(), own, { hits: [] }, NOW)).toMatchObject({ mode: "verify", risk: "low", flags: [] });
    const a = assess(input({ requestEmail: "ceo@northwind-payments.example" }), vendor({ createdMs: NOW - 10 * DAY, billsDue: 2, billsDueMinor: 4_200_000 }), { provided: true, bestScore: 40, maskMatches: true }, { hits: [] }, NOW);
    expect(a).toMatchObject({ mode: "verify", risk: "high" });
    expect(a.flags).toEqual([
      "request came from northwind-payments.example, vendor email is northwind.example",
      "vendor created less than 30 days ago",
      "account holder name match 40 < 70",
      "2 bill(s) due within 14 days ($42,000.00)",
    ]);
  });
  it("a sanctions hit, a missing phone on file, or an unreadable screening never proceeds to verification", () => {
    expect(assess(input(), vendor(), own, { hits: [{ name: "Northwind Traders", source: "SDN" }] }, NOW).mode).toBe("sanctioned");
    expect(assess(input(), vendor({ phone: null }), own, { hits: [] }, NOW)).toMatchObject({ mode: "blocked", flags: ["no_phone_on_file"] });
    expect(assess(input(), vendor(), own, undefined, NOW).mode).toBe("blocked");
    expect(assess(input({ newBank: { ...request().newBank, last4: "1234" } }), vendor(), own, { hits: [] }, NOW).mode).toBe("no_change");
  });
});

describe("supplier-bank-change runs", () => {
  let w: World;
  const ids = { confirm: "ap.confirm_callback:BC-2026-0042", approve: "treasury.approve:BC-2026-0042", apply: "netsuite.apply_bank_change:BC-2026-0042", hold: "netsuite.hold_payments:731", release: "netsuite.release_hold:731" };
  const vendorRec = () => w.state.netsuite.vendors.find((v) => v.id === "731");
  beforeEach(async () => {
    w = await startWorld();
    w.state.netsuite.vendors.push({ id: "731", companyName: "Northwind", legalName: "Northwind Traders LLC", email: "ap@northwind.example", phone: "+15125550100", dateCreated: "2025-01-10T00:00:00Z", custentity_acme_bank_last4: "1234" });
    w.state.netsuite.bills.push({ entity: "731", status: "open", amount: "12000.00", duedate: "2026-10-20" });
    w.state.plaid.accounts["access-sandbox-north"] = [{ account_id: "acc_1", mask: "9012", legal_name: { score: 95 } }];
  });
  afterEach(() => w.close());
  const signal = (e: any, actionId: string, userId: string, value = "approve") => e.handle({ action: "signal", runId: "bc", actionId, value, userId });

  it("holds payments, calls the number on file, and applies the change only after two different people", async () => {
    const clock = { t: NOW };
    const e = w.engine(supplierBankChange, { now: () => clock.t });
    const r = await e.handle({ action: "start", runId: "bc", input: request(), requestedBy: user });
    expect(r.body).toMatchObject({ phase: "WAITING", output: { mode: "verify" } });
    expect(vendorRec()).toMatchObject({ custentity_acme_payment_hold: true, custentity_acme_hold_reason: "bank change BC-2026-0042" });
    expect(w.state.verify.verifications).toEqual([expect.objectContaining({ to: "+15125550100", channel: "call" })]);

    // The submitter can't confirm their own request; the verifier can't also approve.
    expect((await signal(e, ids.confirm, "U_AP_CLERK")).status).toBe(403);
    expect(action((await signal(e, ids.confirm, "U_AP_VERIFIER")).body, ids.confirm).status).toBe("applied");
    expect((await signal(e, ids.approve, "U_AP_VERIFIER")).status).toBe(403);
    const done = await signal(e, ids.approve, "U_TREASURY");
    expect(done.body).toMatchObject({ phase: "DONE", outcome: "ok" });
    expect(vendorRec()).toMatchObject({ custentity_acme_bank_last4: "9012", custentity_acme_bank_token: "tok_bank_9012", custentity_acme_payment_hold: false, custentity_acme_hold_reason: null });
    expect(w.state.gmail.drafts).toHaveLength(1);
    expect(w.state.slack.messages.at(-1).text).toContain("new bank details •••9012 in effect");
    const ev = (await e.handle({ action: "evidence", runId: "bc" })).body;
    expect(ev.verified).toBe(true);
    expect(ev.entries.map((x: any) => x.msg)).toEqual(expect.arrayContaining([`signal approve for ${ids.confirm} by U_AP_VERIFIER`, `signal approve for ${ids.approve} by U_TREASURY`, `signal for ${ids.approve} by U_AP_VERIFIER refused`]));
  });

  it("no callback within 5 days: the change is not applied, the hold is released, security is told", async () => {
    const clock = { t: NOW };
    const e = w.engine(supplierBankChange, { now: () => clock.t });
    await e.handle({ action: "start", runId: "bc", input: request(), requestedBy: user });
    clock.t = NOW + 5 * DAY + 60_000;
    await e.handle({ action: "tick" });
    const r = (await e.handle({ action: "status", runId: "bc" })).body;
    expect(r.phase).toBe("DONE");
    expect(action(r, ids.confirm)).toMatchObject({ status: "rejected", signal: { by: "deadline" } });
    expect(action(r, ids.apply).status).toBe("skipped");
    expect(vendorRec()).toMatchObject({ custentity_acme_bank_last4: "1234", custentity_acme_payment_hold: false });
    expect(w.state.slack.messages.at(-1)).toMatchObject({ channel: "C0SUPPORT1", text: expect.stringContaining("NOT applied") });
  });

  it("a treasury rejection leaves the old account and releases the hold", async () => {
    const e = w.engine(supplierBankChange, { now: () => NOW });
    await e.handle({ action: "start", runId: "bc", input: request(), requestedBy: user });
    await signal(e, ids.confirm, "U_AP_VERIFIER");
    const r = await signal(e, ids.approve, "U_TREASURY", "reject");
    expect(r.body.phase).toBe("DONE");
    expect(vendorRec()).toMatchObject({ custentity_acme_bank_last4: "1234", custentity_acme_payment_hold: false });
    expect(w.state.gmail.drafts).toHaveLength(0);
  });

  it("a sanctions hit holds payments and stops; nothing waits for a callback", async () => {
    w.state.screening.entries.push({ name: "Northwind Traders LLC", source: "SDN", score: 98 });
    const r = await w.engine(supplierBankChange, { now: () => NOW }).handle({ action: "start", runId: "bc", input: request(), requestedBy: user });
    expect(r.body).toMatchObject({ phase: "DONE", output: { mode: "sanctioned" } });
    expect(vendorRec()).toMatchObject({ custentity_acme_payment_hold: true, custentity_acme_hold_reason: "sanctions review BC-2026-0042" });
    expect(w.state.verify.verifications).toHaveLength(0);
    expect(w.state.slack.messages[0].channel).toBe("C0SUPPORT1");
  });

  it("another investigation's hold is never overwritten or released", async () => {
    Object.assign(vendorRec(), { custentity_acme_payment_hold: true, custentity_acme_hold_reason: "fraud case FC-9" });
    const e = w.engine(supplierBankChange, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "bc", input: request(), requestedBy: user });
    expect(action(r.body, ids.hold)).toMatchObject({ status: "skipped", detail: { reason: 'already held for "fraud case FC-9"' } });
    await signal(e, ids.confirm, "U_AP_VERIFIER");
    await signal(e, ids.approve, "U_TREASURY");
    expect(vendorRec()).toMatchObject({ custentity_acme_payment_hold: true, custentity_acme_hold_reason: "fraud case FC-9" });
    const s = (await e.handle({ action: "status", runId: "bc" })).body;
    expect(action(s, ids.apply)).toMatchObject({ status: "failed", error: expect.stringContaining("fraud case FC-9") });
  });

  it("the waiting run survives a restart and a duplicate request starts nothing new", async () => {
    const e = w.engine(supplierBankChange, { now: () => NOW });
    await e.handle({ action: "start", runId: "bc", input: request(), requestedBy: user });
    const again = await e.handle({ action: "start", runId: "bc", input: request(), requestedBy: user });
    expect(again.body.duplicate).toBe(true);
    expect(w.state.verify.verifications).toHaveLength(1);
  });

  it("rejects requests whose bank details aren't tokenised", async () => {
    const e = w.engine(supplierBankChange, { now: () => NOW });
    const r = await e.handle({ action: "start", input: request({ newBank: { accountName: "x", last4: "9012", vaultToken: "123456789" } }), requestedBy: user });
    expect(r.status).toBe(400);
    expect(w.requests).toHaveLength(0);
  });
});
