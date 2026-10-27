import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountTakeoverContainment, assess, POLICY, score, type Billing, type Identity } from "../src/workflows/account-takeover-containment";
import { crossBorderRefund } from "../src/workflows/cross-border-refund";
import { providerFactory } from "../src/providers";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const user = { userId: "U_SECURITY" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const kind = (body: any, k: string) => body.actions.filter((a: any) => a.kind === k);

describe("risk score", () => {
  const billing = (count: number, amountMinor: number): Billing => ({ customers: [], refunds24h: { count, amountMinor, currency: "usd" } });
  it("adds the alert's signals once each and the account's own refund spike", () => {
    expect(score(["mfa_reset", "mfa_reset", "impossible_travel"], billing(0, 0))).toMatchObject({ score: 65, level: "medium" });
    expect(score(["mfa_reset", "impossible_travel"], billing(3, 100))).toMatchObject({ score: 90, level: "high" });
    expect(score(["new_device"], billing(0, POLICY.refundSpike.amountMinor))).toMatchObject({ score: 35, level: "low" });
  });
});

describe("containment decision", () => {
  const contain = (signals: string[]) => accountTakeoverContainment.input.parse({ stage: "contain", alertId: "SEC-1", email: "v@example.com", signals, securityChannel: "C0SUPPORT1" });
  const id = (memberships: Partial<Identity["memberships"][number]>[]): Identity => ({ userId: "u1", sessions: ["s1"], memberships: memberships.map((m, i) => ({ id: `om_${i}`, organizationId: `org_${i}`, role: "admin", status: "active", otherActiveAdmins: 1, ...m })) });
  const bill: Billing = { customers: [{ id: "cus_1", hold: null }], refunds24h: { count: 0, amountMinor: 0, currency: "usd" } };
  const HIGH = ["mfa_reset", "admin_role_granted"];

  it("high risk removes privileged memberships automatically, except an organization's last admin", () => {
    const a = assess(contain(HIGH), id([{}, { otherActiveAdmins: 0 }, { role: "member" }]), bill);
    expect(a).toMatchObject({ mode: "contain", holds: ["cus_1"], revokeSessions: true });
    expect(a.removals.map((r) => [r.membershipId, r.gate, r.why])).toEqual([
      ["om_0", "auto", "high risk"],
      ["om_1", "approval", "last admin of the organization"],
    ]);
  });
  it("medium risk asks before removing anything; low risk only watches", () => {
    expect(assess(contain(["mfa_reset", "new_device"]), id([{}]), bill).removals[0]!.gate).toBe("approval");
    expect(assess(contain(["new_device"]), id([{}]), bill)).toMatchObject({ mode: "monitor", removals: [], holds: [] });
  });
  it("caps automatic removals per alert", () => {
    const a = assess(contain(HIGH), id(Array.from({ length: POLICY.autoRemoveMax + 2 }, () => ({}))), bill);
    expect(a.removals.filter((r) => r.gate === "auto")).toHaveLength(POLICY.autoRemoveMax);
  });
  it("never removes blindly: without the directory it is blocked; already contained is nothing", () => {
    expect(assess(contain(HIGH), undefined, bill)).toMatchObject({ mode: "blocked", removals: [], holds: [] });
    expect(assess(contain(HIGH), { userId: "u1", sessions: [], memberships: [{ id: "om", organizationId: "o", role: "member", status: "active", otherActiveAdmins: 0 }] }, { ...bill, customers: [{ id: "cus_1", hold: "SEC-1" }] })).toMatchObject({ mode: "nothing", reason: "already contained" });
  });
  it("restore puts back only what is missing and releases only this alert's hold", () => {
    const restore = accountTakeoverContainment.input.parse({ stage: "restore", alertId: "SEC-1", email: "v@example.com", securityChannel: "C0SUPPORT1", memberships: [{ organizationId: "org_a", role: "admin" }, { organizationId: "org_0", role: "admin" }] });
    const a = assess(restore, id([{}]), { ...bill, customers: [{ id: "cus_1", hold: "SEC-1" }, { id: "cus_2", hold: "SEC-2" }] });
    expect(a).toMatchObject({ mode: "restore", restores: [{ organizationId: "org_a", role: "admin" }], releases: ["cus_1"] });
  });
});

describe("account-takeover-containment runs", () => {
  let w: World;
  const EMAIL = "victim@customer.example";
  const contain = (over: object = {}) => ({ stage: "contain", alertId: "SEC-2026-0042", email: EMAIL, signals: ["mfa_reset", "admin_role_granted"], source: "idp-risk", securityChannel: "C0SUPPORT1", approvers: ["U_CISO"], ...over });
  beforeEach(async () => {
    w = await startWorld();
    const W = w.state.workos;
    W.users.push({ id: "user_v", email: EMAIL }, { id: "user_o", email: "other@customer.example" });
    W.memberships.push(
      { id: "om_v_a", user_id: "user_v", organization_id: "org_a", role: { slug: "admin" }, status: "active" },
      { id: "om_o_a", user_id: "user_o", organization_id: "org_a", role: { slug: "admin" }, status: "active" },
      { id: "om_v_b", user_id: "user_v", organization_id: "org_b", role: { slug: "admin" }, status: "active" },
      { id: "om_v_c", user_id: "user_v", organization_id: "org_c", role: { slug: "member" }, status: "active" },
    );
    W.sessions.push({ id: "ses_1", user_id: "user_v" }, { id: "ses_2", user_id: "user_v" }, { id: "ses_o", user_id: "user_o" });
    w.state.stripe.customers.push({ id: "cus_v", email: EMAIL, metadata: {} });
  });
  afterEach(() => w.close());

  it("contains a high-risk takeover: hold, sessions, the shared admin seat now and the sole admin seat on approval", async () => {
    const e = w.engine(accountTakeoverContainment, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "ato", input: contain(), requestedBy: user });
    expect(r.body).toMatchObject({ phase: "AWAITING_APPROVAL", output: { mode: "contain", level: "high", removals: 2, removalsAuto: 1, holds: 1 } });
    expect(w.state.stripe.customers.find((c) => c.id === "cus_v").metadata.acme_ato_hold).toBe("SEC-2026-0042");
    expect(w.state.workos.sessions.filter((s) => s.revoked).map((s) => s.id)).toEqual(["ses_1", "ses_2"]);
    expect(w.state.workos.memberships.map((m) => m.id)).toEqual(["om_o_a", "om_v_b", "om_v_c"]);
    expect(action(r.body, "workos.remove_membership:om_v_b")).toMatchObject({ gate: "approval", status: "pending_approval", summary: { why: "last admin of the organization" } });
    expect(w.state.asana.tasks[0].notes).toContain('"memberships":[{"organizationId":"org_a","role":"admin"},{"organizationId":"org_b","role":"admin"}]');

    expect((await e.handle({ action: "decide", runId: "ato", decision: "approve", userId: "U_HELPDESK" })).status).toBe(403);
    await e.handle({ action: "decide", runId: "ato", decision: "approve", userId: "U_CISO" });
    expect(w.state.workos.memberships.map((m) => m.id)).toEqual(["om_o_a", "om_v_c"]);
    const rec = await e.handle({ action: "reconcile", runId: "ato" });
    expect(action(rec.body, "workos.remove_membership:om_v_a").reconcile.status).toBe("match");
    expect(action(rec.body, "stripe.hold_customer:cus_v").reconcile.status).toBe("match");
  });

  it("refuses to auto-remove an admin whose co-admin left since the scan", async () => {
    // The scan counts the co-admin; by the time the removal runs they are gone.
    const base = providerFactory(w.endpoints());
    let scans = 0;
    const providers = (c: Record<string, string>) => {
      const p = base(c);
      const list = p.workos!.listOrganizationMemberships.bind(p.workos!);
      p.workos!.listOrganizationMemberships = async (org: string) => {
        const res = await list(org);
        if (++scans === 2) w.state.workos.memberships = w.state.workos.memberships.filter((m) => m.id !== "om_o_a");
        return res;
      };
      return p;
    };
    const e = w.engine(accountTakeoverContainment, { now: () => NOW, providers });
    const r = await e.handle({ action: "start", runId: "ato", input: contain(), requestedBy: user });
    expect(action(r.body, "workos.remove_membership:om_v_a")).toMatchObject({ gate: "auto", status: "failed", error: expect.stringContaining("org_a would have no admin left") });
    expect(w.state.workos.memberships.map((m) => m.id)).toContain("om_v_a");
  });

  it("a re-delivered or repeated alert contains once and then finds nothing to do", async () => {
    const e = w.engine(accountTakeoverContainment, { now: () => NOW });
    await Promise.all([1, 2, 3].map(() => e.handle({ action: "start", runId: "ato", input: contain({ signals: ["mfa_reset", "impossible_travel", "mass_export"] }), requestedBy: user })));
    await e.idle();
    const again = await e.handle({ action: "start", runId: "ato-2", input: contain({ signals: ["mfa_reset", "impossible_travel", "mass_export"] }), requestedBy: user });
    expect(kind(again.body, "workos.remove_membership").filter((a: any) => a.gate === "auto")).toHaveLength(0);
    expect(kind(again.body, "stripe.hold_customer")).toHaveLength(0);
    expect(w.state.workos.memberships.filter((m) => m.user_id === "user_v").map((m) => m.id)).toEqual(["om_v_b", "om_v_c"]);
  });

  it("medium risk holds refunds and revokes sessions but removes nothing without approval", async () => {
    const e = w.engine(accountTakeoverContainment, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "ato", input: contain({ signals: ["mfa_reset", "new_device"] }), requestedBy: user });
    expect(r.body).toMatchObject({ phase: "AWAITING_APPROVAL", output: { level: "medium", removalsAuto: 0 } });
    expect(w.state.workos.memberships).toHaveLength(4);
    await e.handle({ action: "decide", runId: "ato", decision: "reject", userId: "U_CISO" });
    expect(w.state.workos.memberships).toHaveLength(4);
    expect(w.state.stripe.customers.find((c) => c.id === "cus_v").metadata.acme_ato_hold).toBe("SEC-2026-0042");
  });

  it("a refund spike on the account raises a medium alert to high", async () => {
    w.state.stripe.paymentIntents.push({ id: "pi_v1", customer: "cus_v", amount: 90_000, amount_received: 90_000, currency: "usd", status: "succeeded", latest_charge: "ch_v1", created: Math.floor(NOW / 1000) - 7_200 });
    w.state.stripe.refunds.push({ id: "re_v1", amount: 60_000, currency: "usd", payment_intent: "pi_v1", status: "succeeded", created: Math.floor(NOW / 1000) - 3_600 });
    const e = w.engine(accountTakeoverContainment, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "ato", input: contain({ signals: ["mfa_reset", "new_device"] }), requestedBy: user });
    expect(r.body.output).toMatchObject({ score: 70, level: "high", removalsAuto: 1 });
  });

  it("fails safe: without WorkOS nothing is removed and Slack escalates", async () => {
    w.faults.push({ method: "GET", path: /^\/user_management\/users$/, status: 401, body: { code: "unauthorized" } });
    const e = w.engine(accountTakeoverContainment, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "ato", input: contain(), requestedBy: user });
    expect(r.body.output).toMatchObject({ mode: "blocked" });
    expect(kind(r.body, "stripe.hold_customer")).toHaveLength(0);
    expect(w.state.workos.memberships).toHaveLength(4);
    expect(w.state.slack.messages[0].text).toContain(":rotating_light:");
  });

  it("restore puts memberships back and releases the hold only with approval", async () => {
    const e = w.engine(accountTakeoverContainment, { now: () => NOW });
    await e.handle({ action: "start", runId: "ato", input: contain(), requestedBy: user });
    await e.handle({ action: "decide", runId: "ato", decision: "approve", userId: "U_CISO" });
    const restore = { stage: "restore", alertId: "SEC-2026-0042", email: EMAIL, memberships: [{ organizationId: "org_a", role: "admin" }, { organizationId: "org_b", role: "admin" }, { organizationId: "org_c", role: "member" }], securityChannel: "C0SUPPORT1", approvers: ["U_CISO"] };
    const r = await e.handle({ action: "start", runId: "restore", input: restore, requestedBy: user });
    expect(r.body).toMatchObject({ phase: "AWAITING_APPROVAL", output: { mode: "restore", restores: 2, releases: 1 } });
    expect(w.state.workos.memberships.filter((m) => m.user_id === "user_v")).toHaveLength(1);
    await e.handle({ action: "decide", runId: "restore", decision: "approve", userId: "U_CISO" });
    expect(w.state.workos.memberships.filter((m) => m.user_id === "user_v").map((m) => [m.organization_id, m.role.slug]).sort()).toEqual([["org_a", "admin"], ["org_b", "admin"], ["org_c", "member"]]);
    expect(w.state.stripe.customers.find((c) => c.id === "cus_v").metadata.acme_ato_hold).toBe("");
  });

  it("the hold stops the cross-border refund workflow from moving money on the account", async () => {
    w.state.stripe.paymentIntents.push({ id: "pi_v_eur01", customer: "cus_v", amount: 5_000, amount_received: 5_000, currency: "eur", status: "succeeded", latest_charge: "ch_v2", created: Math.floor(NOW / 1000) - 600 });
    w.state.zendesk.tickets.push({ id: 77, status: "open", requester_id: 70, requester_email: EMAIL, description: "refund please" });
    await w.engine(accountTakeoverContainment, { now: () => NOW }).handle({ action: "start", runId: "ato", input: contain(), requestedBy: user });
    const r = await w.engine(crossBorderRefund, { now: () => NOW }).handle({ action: "start", runId: "rf", input: { ticketId: 77, paymentIntent: "pi_v_eur01", supportChannel: "C0SUPPORT1" }, requestedBy: user });
    expect(r.body.output).toMatchObject({ mode: "review", reason: "the account is under an account-takeover hold (SEC-2026-0042)" });
    expect(w.state.stripe.refunds.filter((x) => x.payment_intent === "pi_v_eur01")).toHaveLength(0);
  });

  it("rejects malformed alerts before any provider call", async () => {
    const e = w.engine(accountTakeoverContainment, { now: () => NOW });
    for (const bad of [contain({ signals: [] }), contain({ signals: ["looks_bad"] }), contain({ email: "not-an-email" }), { ...contain(), stage: "restore", memberships: [{ organizationId: "org_a", role: "admin" }, { organizationId: "org_a", role: "member" }] }]) {
      expect((await e.handle({ action: "start", input: bad, requestedBy: user })).status).toBe(400);
    }
    expect(w.requests).toHaveLength(0);
  });
});
