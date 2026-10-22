import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chain, purchaseRequestToPo } from "../src/workflows/purchase-request-to-po";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const DAY = 86_400_000;
const user = { userId: "U_INTAKE" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const input = (over: object = {}) => ({
  requestId: "PR-2026-0042",
  requester: "U_REQ",
  vendorId: "301",
  description: "Load-testing service, 12 months",
  amount: 12_000_00,
  currency: "usd",
  department: { id: "7", name: "Engineering", annualBudget: 100_000_00 },
  expenseAccount: "6100",
  approvers: { manager: ["U_MGR", "U_REQ"], finance: ["U_FIN", "U_MGR"], vp: ["U_VP"], cfo: ["U_CFO"] },
  procurementChannel: "C0FINANCE1",
  ...over,
});
const sig = (role: string, userId: string, value: "approve" | "reject" = "approve") => ({ action: "signal" as const, runId: "p", actionId: `approve.${role}:PR-2026-0042`, value, userId });

describe("delegation of authority", () => {
  it("adds approvers by amount, and finance whenever over budget", () => {
    expect(chain(1_000_00, false)).toEqual(["manager"]);
    expect(chain(1_000_00, true)).toEqual(["manager", "finance"]);
    expect(chain(60_000_00, false)).toEqual(["manager", "finance", "vp"]);
    expect(chain(300_000_00, false)).toEqual(["manager", "finance", "vp", "cfo"]);
  });
});

describe("purchase-request-to-po runs", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
    w.state.netsuite.vendors.push({ id: "301", companyName: "Loadster", legalName: "Loadster Inc" });
  });
  afterEach(() => w.close());

  it("manager then finance approve, the PO is raised once and the requester gets its number", async () => {
    const e = w.engine(purchaseRequestToPo, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "p", input: input(), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "approval", chain: ["manager", "finance"], approvalPath: "manager > finance", overBudget: false, possibleDuplicates: 0 });
    expect((await e.handle(sig("manager", "U_REQ"))).status).toBe(403);
    await e.handle(sig("manager", "U_MGR"));
    // Someone who already approved this request can't approve it again in another role.
    expect((await e.handle(sig("finance", "U_MGR"))).status).toBe(403);
    const done = await e.handle(sig("finance", "U_FIN"));
    expect(w.state.netsuite.purchaseOrders).toEqual([expect.objectContaining({ externalId: "PR-2026-0042", entity: { id: "301" }, total: 12000 })]);
    expect(action(done.body, "netsuite.create_po:PR-2026-0042").status).toBe("applied");
    expect(w.state.slack.messages.at(-1)).toMatchObject({ channel: "U_REQ", text: expect.stringMatching(/approved: purchase order PO\d+ for \$12,000\.00/) });
  });

  it("an existing PO for the request is reused, not raised again", async () => {
    w.state.netsuite.purchaseOrders.push({ id: "88", tranId: "PO88", externalId: "PR-2026-0042", entity: { id: "301" }, total: 12000 });
    const e = w.engine(purchaseRequestToPo, { now: () => NOW });
    await e.handle({ action: "start", runId: "p", input: input({ amount: 900_00 }), requestedBy: user });
    const r = await e.handle(sig("manager", "U_MGR"));
    expect(action(r.body, "netsuite.create_po:PR-2026-0042")).toMatchObject({ ref: "88", detail: { reused: true } });
    expect(w.state.netsuite.purchaseOrders).toHaveLength(1);
  });

  it("over budget brings finance in; a possible duplicate is flagged", async () => {
    w.state.netsuite.purchaseOrders.push({ id: "77", tranId: "PO77", entity: { id: "301" }, department: { id: "7" }, total: 99500 });
    w.state.netsuite.purchaseOrders.push({ id: "78", tranId: "PO78", entity: { id: "301" }, department: { id: "9" }, total: 900 });
    const r = await w.engine(purchaseRequestToPo, { now: () => NOW }).handle({ action: "start", runId: "p", input: input({ amount: 900_00 }), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "approval", chain: ["manager", "finance"], approvalPath: "manager > finance", overBudget: true, possibleDuplicates: 1 });
    expect(w.state.slack.messages[0].text).toMatch(/Over budget: \$500\.00 left\. :warning: Possible duplicate of PO78/);
  });

  it("a slow approver is reminded, then the request lapses with no PO", async () => {
    const clock = { t: NOW };
    const e = w.engine(purchaseRequestToPo, { now: () => clock.t });
    await e.handle({ action: "start", runId: "p", input: input(), requestedBy: user });
    await e.handle(sig("manager", "U_MGR"));
    clock.t = NOW + 3 * DAY + 1;
    await e.handle({ action: "tick" });
    expect(w.state.slack.messages.at(-1).text).toMatch(/waited 3 days for finance approval: <@U_FIN> <@U_MGR>/);
    clock.t = NOW + 7 * DAY + 1;
    await e.handle({ action: "tick" });
    const s = (await e.handle({ action: "status", runId: "p" })).body;
    expect(action(s, "approve.finance:PR-2026-0042").status).toBe("rejected");
    expect(action(s, "netsuite.create_po:PR-2026-0042").status).toBe("skipped");
    expect(w.state.netsuite.purchaseOrders).toHaveLength(0);
    expect(w.state.slack.messages.at(-1)).toMatchObject({ channel: "U_REQ", text: expect.stringMatching(/was not approved; no purchase order/) });
  });

  it("a vendor put on hold during approval gets no PO", async () => {
    const e = w.engine(purchaseRequestToPo, { now: () => NOW });
    await e.handle({ action: "start", runId: "p", input: input({ amount: 900_00 }), requestedBy: user });
    w.state.netsuite.vendors[0].custentity_acme_payment_hold = true;
    const r = await e.handle(sig("manager", "U_MGR"));
    expect(action(r.body, "netsuite.create_po:PR-2026-0042")).toMatchObject({ status: "failed", error: expect.stringMatching(/put on hold during approval/) });
  });

  it("an inactive or sanctioned vendor stops the request before any approval", async () => {
    w.state.netsuite.vendors[0].isInactive = true;
    const r = await w.engine(purchaseRequestToPo, { now: () => NOW }).handle({ action: "start", runId: "p", input: input(), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "stopped" });
    expect(r.body.actions.map((a: any) => a.kind)).toEqual(["slack.post_stopped"]);
    expect(w.state.slack.messages[0].text).toMatch(/stopped: vendor is inactive/);
  });
});
