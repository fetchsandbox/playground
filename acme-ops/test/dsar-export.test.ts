import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completeness, dsarExport } from "../src/workflows/dsar-export";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const DAY = 86_400_000;
const user = { userId: "U_PRIVACY_INTAKE" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const input = (over: object = {}) => ({ requestId: "DSAR-2026-0042", subject: { email: "alice@acmecorp.com", name: "Alice" }, regulation: "gdpr", receivedAt: new Date(NOW).toISOString(), privacyChannel: "C0SUPPORT1", exportFolderId: "777", verifiers: ["U_VERIFIER", "U_ANALYST"], analysts: ["U_ANALYST", "U_ANALYST_2"], ...over });
const signal = (actionId: string, userId: string, value: "approve" | "reject" = "approve") => ({ action: "signal" as const, runId: "d", actionId, value, userId });
const tick = async (e: any) => (await e.handle({ action: "tick" }), (await e.handle({ action: "status", runId: "d" })).body);

describe("completeness", () => {
  it("every system must be searched, and a cut-short search is incomplete", () => {
    const ok = { crm: { contactIds: [] }, billing: { customerIds: [], invoiceIds: [] }, support: { ticketIds: [], truncated: false } };
    expect(completeness(ok)).toEqual({ complete: true, missing: [] });
    expect(completeness({ ...ok, billing: null }).missing).toEqual(["billing (Stripe)"]);
    expect(completeness({ ...ok, support: { ticketIds: [], truncated: true } }).missing[0]).toMatch(/more than 200/);
  });
});

describe("dsar-export runs", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
    w.state.hubspot.contacts.push({ id: "601", properties: { email: "alice@acmecorp.com", firstname: "Alice", phone: "+1 555 0100" } });
    w.state.stripe.invoices.push({ id: "in_alice_1", customer: "cus_alice", status: "paid", amount_due: 4900, amount_remaining: 0, currency: "usd" });
    w.state.zendesk.tickets.push({ id: 31, subject: "Cannot log in", status: "solved", requester_email: "alice@acmecorp.com" }, { id: 32, subject: "Someone else", requester_email: "bob@example.com" });
    w.state.zendesk.comments.push({ id: 1, ticketId: 31, public: true, body: "I can't log in" }, { id: 2, ticketId: 31, public: false, body: "internal: likely SSO" });
  });
  afterEach(() => w.close());

  it("verify → export → a different analyst releases → expiring link in a draft; reminders skip once drafted", async () => {
    const clock = { t: NOW };
    const e = w.engine(dsarExport, { now: () => clock.t });
    const r = await e.handle({ action: "start", runId: "d", input: input(), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "export", deadline: "2026-11-13", crm: 1, customers: 1, invoices: 1, tickets: 1 });
    expect(w.state.asana.tasks[0].notes).not.toContain("alice@acmecorp.com");
    expect(w.state.box.files).toHaveLength(0);

    await e.handle(signal("privacy.verify_identity:DSAR-2026-0042", "U_ANALYST"));
    const exported = w.state.box.files.find((f) => f.name === "DSAR-2026-0042-export.json")!;
    const doc = JSON.parse(exported.content!);
    expect(doc.systems.crm[0].properties.phone).toBe("+1 555 0100");
    expect(doc.systems.billing.invoices.map((i: any) => i.id)).toEqual(["in_alice_1"]);
    expect(doc.systems.support).toEqual([expect.objectContaining({ id: 31, comments: [{ body: "I can't log in" }] })]);

    // The verifier may not also release the export.
    expect((await e.handle(signal("privacy.approve_export:DSAR-2026-0042", "U_ANALYST"))).status).toBe(403);
    const done = await e.handle(signal("privacy.approve_export:DSAR-2026-0042", "U_ANALYST_2"));
    expect(exported.sharedLink?.unshared_at.slice(0, 10)).toBe("2026-10-21");
    expect(Buffer.from(w.state.gmail.drafts[0].message.raw, "base64url").toString()).toContain(exported.sharedLink!.url);
    expect(action(done.body, "gmail.draft_response:DSAR-2026-0042").status).toBe("applied");

    clock.t = NOW + 27 * DAY + 1;
    const end = await tick(e);
    expect(action(end, "slack.remind:DSAR-2026-0042")).toMatchObject({ status: "skipped", detail: { reason: "response drafted" } });
    expect(action(end, "privacy.escalate:DSAR-2026-0042")).toMatchObject({ status: "skipped" });
    expect(end.phase).toBe("DONE");
  });

  it("a re-run never uploads a second export", async () => {
    w.state.box.files.push({ id: "55", name: "DSAR-2026-0042-export.json", text: null, folder: "777" });
    const e = w.engine(dsarExport, { now: () => NOW });
    await e.handle({ action: "start", runId: "d", input: input(), requestedBy: user });
    const r = await e.handle(signal("privacy.verify_identity:DSAR-2026-0042", "U_VERIFIER"));
    expect(action(r.body, "box.upload_export:DSAR-2026-0042")).toMatchObject({ status: "applied", ref: "55", detail: { reused: true } });
    expect(w.state.box.files).toHaveLength(1);
  });

  it("unverified requests export nothing and stop after the verification window; reminders still fire on an open request", async () => {
    const clock = { t: NOW };
    const e = w.engine(dsarExport, { now: () => clock.t });
    await e.handle({ action: "start", runId: "d", input: input(), requestedBy: user });
    clock.t = NOW + 10 * DAY + 1;
    const r = await tick(e);
    expect(action(r, "box.upload_export:DSAR-2026-0042").status).toBe("skipped");
    expect(w.state.box.files).toHaveLength(0);
    clock.t = NOW + 20 * DAY + 1;
    const later = await tick(e);
    expect(action(later, "slack.remind:DSAR-2026-0042")).toMatchObject({ status: "skipped", detail: { reason: "request closed without an export" } });
  });

  it("an open request is reminded and then escalated", async () => {
    const clock = { t: NOW };
    const e = w.engine(dsarExport, { now: () => clock.t });
    await e.handle({ action: "start", runId: "d", input: input(), requestedBy: user });
    await e.handle(signal("privacy.verify_identity:DSAR-2026-0042", "U_VERIFIER"));
    clock.t = NOW + 20 * DAY + 1;
    await e.handle({ action: "tick" });
    clock.t = NOW + 27 * DAY + 1;
    await e.handle({ action: "tick" });
    const posts = w.state.slack.messages.map((m: any) => m.text);
    expect(posts.some((t: string) => /due 2026-11-13 \(10 days\)\. Waiting on export review/.test(t))).toBe(true);
    expect(posts.some((t: string) => /misses its GDPR deadline in 3 days/.test(t))).toBe(true);
  });

  it("when a system can't be searched, nothing is exported and privacy-ops is told", async () => {
    w.faults.push({ method: "GET", path: /^\/api\/v2\/search\.json$/, status: 503, body: {} });
    const r = await w.engine(dsarExport, { now: () => NOW }).handle({ action: "start", runId: "d", input: input(), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "blocked", missing: ["support (Zendesk)"] });
    expect(r.body.actions.map((a: any) => a.kind)).toEqual(["asana.dsar_record", "slack.post_blocked"]);
  });

  it("rejects a malformed request id", async () => {
    const r = await w.engine(dsarExport, { now: () => NOW }).handle({ action: "start", runId: "d", input: input({ requestId: "42" }), requestedBy: user });
    expect(r.status).toBe(400);
  });
});
