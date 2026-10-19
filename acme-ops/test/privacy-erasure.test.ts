import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decide, erasedEmail, privacyErasure } from "../src/workflows/privacy-erasure";
import { addSub, NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const user = { userId: "U_PRIVACY" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);

describe("privacy-erasure decisions", () => {
  const billing = { customerId: "cus_1", liveSubscriptions: [], openInvoices: [], alreadyErased: false };
  it("erases CRM and login, anonymizes billing, and holds billing under an active contract or unpaid invoice", () => {
    expect(decide({ contactId: "1" }, billing, { userId: "u", privilegedRoles: [] }).map((d) => d.action)).toEqual(["erase", "anonymize", "erase"]);
    expect(decide({ contactId: null }, { ...billing, liveSubscriptions: ["sub_1"] }, { userId: null, privilegedRoles: [] }).map((d) => d.action)).toEqual(["none", "retain", "none"]);
    expect(decide(undefined, { ...billing, openInvoices: ["in_1"] }, undefined).map((d) => d.action)).toEqual(["unknown", "retain", "unknown"]);
    expect(decide({ contactId: null }, { ...billing, alreadyErased: true }, { userId: "u", privilegedRoles: ["billing-admin"] })[2]!.reason).toContain("security must confirm");
  });
});

describe("privacy-erasure runs", () => {
  let w: World;
  const input = (over: object = {}) => ({
    requestId: "DSR-2026-0042",
    subject: { email: "Erin@Example.com", name: "Erin Example" },
    regulation: "gdpr",
    receivedAt: "2026-10-10T09:00:00Z",
    verification: { method: "email_link", verifiedBy: "privacy-portal" },
    privacyChannel: "C0SUPPORT1",
    approvers: ["U_DPO"],
    ...over,
  });

  beforeEach(async () => {
    w = await startWorld();
    w.state.hubspot.contacts.push({ id: "501", properties: { email: "erin@example.com", firstname: "Erin" } });
    w.state.stripe.customers.push({ id: "cus_erin", email: "erin@example.com", name: "Erin Example", phone: "+15550100", metadata: {} });
    w.state.workos.users.push({ id: "user_erin", email: "erin@example.com", first_name: "Erin" });
    w.state.workos.memberships.push({ id: "om_1", user_id: "user_erin", organization_id: "org_acme", role: { slug: "member" } });
  });
  afterEach(() => w.close());

  it("discovers in parallel, records the request, waits for approval, then erases and drafts the response", async () => {
    const e = w.engine(privacyErasure, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "DSR-2026-0042", input: input(), requestedBy: user });
    expect(r.status).toBe(200);
    expect(r.body.phase).toBe("AWAITING_APPROVAL");
    expect(r.body.output).toMatchObject({ verified: true, complete: true, daysLeft: 25, decisions: { hubspot: "erase", stripe: "anonymize", workos: "erase" } });
    for (const id of ["hubspot.erase_contact", "stripe.anonymize_customer", "workos.delete_user", "gmail.draft_completion"]) expect(action(r.body, id).status).toBe("pending_approval");
    expect(action(r.body, "asana.dsar_record").status).toBe("applied");
    // The record and the channel never carry the requester's address.
    expect(JSON.stringify(w.state.asana.tasks)).not.toContain("erin@example.com");
    expect(w.state.asana.tasks[0].due_on).toBe("2026-11-09");
    expect(w.state.slack.messages[0].text).not.toContain("erin@");
    expect(w.state.hubspot.contacts).toHaveLength(1);

    expect((await e.handle({ action: "decide", runId: "DSR-2026-0042", decision: "approve", userId: "U_SUPPORT" })).status).toBe(403);
    const ok = await e.handle({ action: "decide", runId: "DSR-2026-0042", decision: "approve", userId: "U_DPO" });
    expect(ok.body).toMatchObject({ phase: "DONE", outcome: "ok" });
    expect(w.state.hubspot.contacts).toHaveLength(0);
    expect(w.state.workos.users).toHaveLength(0);
    expect(w.state.stripe.customers.find((c) => c.id === "cus_erin")).toMatchObject({ email: erasedEmail("DSR-2026-0042"), name: "Erased customer", phone: "", metadata: { acme_erased: "DSR-2026-0042" } });
    expect(w.state.gmail.drafts).toHaveLength(1);

    const rec = await e.handle({ action: "reconcile", runId: "DSR-2026-0042" });
    for (const id of ["hubspot.erase_contact", "stripe.anonymize_customer", "workos.delete_user"]) expect(action(rec.body, id).reconcile.status).toBe("match");
  });

  it("rejection erases nothing", async () => {
    const e = w.engine(privacyErasure, { now: () => NOW });
    await e.handle({ action: "start", runId: "dsr", input: input(), requestedBy: user });
    const rej = await e.handle({ action: "decide", runId: "dsr", decision: "reject", userId: "U_DPO" });
    expect(rej.body.phase).toBe("REJECTED");
    expect(w.state.hubspot.contacts).toHaveLength(1);
    expect(w.state.workos.users).toHaveLength(1);
    expect(w.state.stripe.customers.find((c) => c.id === "cus_erin").email).toBe("erin@example.com");
  });

  it("an unverified request erases nothing and drafts a verification request", async () => {
    const e = w.engine(privacyErasure, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "dsr", input: input({ verification: { method: "none", verifiedBy: "inbox" } }), requestedBy: user });
    expect(r.body.phase).toBe("DONE");
    expect(action(r.body, "gmail.draft_verification_request").status).toBe("applied");
    for (const id of ["hubspot.erase_contact", "stripe.anonymize_customer", "workos.delete_user"]) expect(action(r.body, id)).toBeUndefined();
  });

  it("holds billing data under an active subscription and still erases the rest", async () => {
    addSub(w.state, "cus_erin", "price_pro_monthly", "active");
    const e = w.engine(privacyErasure, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "dsr", input: input(), requestedBy: user });
    expect(r.body.output.decisions).toMatchObject({ hubspot: "erase", stripe: "retain", workos: "erase" });
    expect(action(r.body, "stripe.anonymize_customer")).toBeUndefined();
    await e.handle({ action: "decide", runId: "dsr", decision: "approve", userId: "U_DPO" });
    expect(w.state.gmail.drafts[0].message.raw).toBeTruthy();
    const body = Buffer.from(w.state.gmail.drafts[0].message.raw, "base64url").toString("utf8");
    expect(body).toContain("billing (Stripe): kept (active subscription");
  });

  it("re-checks the hold at write time: a subscription started after discovery blocks anonymization and the response", async () => {
    const e = w.engine(privacyErasure, { now: () => NOW });
    await e.handle({ action: "start", runId: "dsr", input: input(), requestedBy: user });
    addSub(w.state, "cus_erin", "price_pro_monthly", "active");
    const ok = await e.handle({ action: "decide", runId: "dsr", decision: "approve", userId: "U_DPO" });
    expect(action(ok.body, "stripe.anonymize_customer")).toMatchObject({ status: "failed", errorCode: "fatal" });
    expect(action(ok.body, "gmail.draft_completion")).toMatchObject({ status: "failed", errorCode: "fatal" });
    expect(ok.body.outcome).toBe("partial");
    expect(w.state.gmail.drafts).toHaveLength(0);
  });

  it("with a system unreachable, the request stays open: no completion response", async () => {
    w.faults.push({ method: "GET", path: /^\/user_management\/users$/, status: 401, body: { code: "unauthorized" } });
    const e = w.engine(privacyErasure, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "dsr", input: input(), requestedBy: user });
    expect(r.body.agents.find((a: any) => a.name === "identity-records").status).toBe("failed");
    expect(r.body.output).toMatchObject({ complete: false, decisions: { workos: "unknown" } });
    expect(action(r.body, "gmail.draft_completion")).toBeUndefined();
    expect(action(r.body, "hubspot.erase_contact").status).toBe("pending_approval");
  });

  it("rejects a malformed request id before any agent runs", async () => {
    const e = w.engine(privacyErasure, { now: () => NOW });
    const r = await e.handle({ action: "start", input: input({ requestId: "x" }), requestedBy: user });
    expect(r.status).toBe(400);
    expect(w.requests).toHaveLength(0);
  });
});
