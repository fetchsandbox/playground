import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contractIntake, review, type ClauseSet } from "../src/workflows/contract-intake";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const DAY = 86_400_000;
const user = { userId: "U_SALES_REP" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const clauses = (o: Partial<ClauseSet> = {}): ClauseSet => ({ governingLaw: "US-NY", termYears: 2, liabilityCapMultiple: null, autoRenews: false, renewalNoticeDays: null, expiresOn: null, flags: [], ...o });
const input = (over: object = {}) => ({ contractId: "CTR-2026-0042", boxFileId: "9001", type: "nda", counterparty: { name: "Northwind", signerName: "Kim Lee", signerEmail: "kim@northwind.example" }, acmeSigner: { name: "Pat Legal", email: "pat@acme.example" }, requester: "U_SALES_REP", lawyers: ["U_LAWYER", "U_SALES_REP"], legalChannel: "C0SUPPORT1", ...over });

describe("playbook", () => {
  it("a standard NDA is clean; deviations and every MSA need a lawyer", () => {
    expect(review("nda", clauses(), null)).toEqual({ clean: true, deviations: [] });
    expect(review("nda", clauses({ governingLaw: "FR", termYears: 10, flags: ["exclusivity", "audit_rights"] }), null).deviations).toEqual(["governing law FR", "term 10 years (max 5)", "exclusivity"]);
    expect(review("msa", clauses({ liabilityCapMultiple: 2 }), null).deviations).toEqual(["every MSA is reviewed by a lawyer"]);
    expect(review("msa", clauses(), null).deviations[0]).toBe("liability cap uncapped");
    expect(review("nda", null, "answer came from role \"system\"").clean).toBe(false);
  });
});

describe("contract-intake runs", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
    w.state.box.files.push({ id: "9001", name: "Northwind NDA.pdf", text: "MUTUAL NON-DISCLOSURE AGREEMENT ... governed by the laws of the State of New York ..." });
  });
  afterEach(() => w.close());

  it("a clean NDA goes straight to DocuSign, is chased, and gets a renewal reminder once signed", async () => {
    w.state.openai.replies.push({ content: JSON.stringify(clauses({ autoRenews: true, expiresOn: "2028-11-01", renewalNoticeDays: 60 })) });
    const clock = { t: NOW };
    const e = w.engine(contractIntake, { now: () => clock.t });
    const r = await e.handle({ action: "start", runId: "c", input: input(), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "clean", deviations: [] });
    expect(w.state.docusign.envelopes).toEqual([expect.objectContaining({ externalId: "CTR-2026-0042", status: "sent" })]);
    expect(w.state.openai.calls[0].messages[1].content).toMatch(/^<contract>/);
    clock.t = NOW + 3 * DAY + 1;
    await e.handle({ action: "tick" });
    expect(w.state.docusign.envelopes[0].reminders).toBe(1);
    w.state.docusign.envelopes[0].status = "completed";
    clock.t = NOW + 31 * DAY;
    await e.handle({ action: "tick" });
    const s = (await e.handle({ action: "status", runId: "c" })).body;
    expect(action(s, "docusign.void_if_unsigned:CTR-2026-0042")).toMatchObject({ status: "skipped", detail: { reason: "signed" } });
    expect(w.state.asana.tasks[0]).toMatchObject({ name: "CTR-2026-0042: renewal notice due 2028-09-02 (Northwind)", due_on: "2028-08-03" });
    expect(s.phase).toBe("DONE");
  });

  it("deviations wait for a lawyer who isn't the requester; unsigned envelopes are voided after 30 days", async () => {
    w.state.openai.replies.push({ content: JSON.stringify(clauses({ governingLaw: "FR" })) });
    const clock = { t: NOW };
    const e = w.engine(contractIntake, { now: () => clock.t });
    const r = await e.handle({ action: "start", runId: "c", input: input(), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "review", deviations: ["governing law FR"] });
    expect(w.state.docusign.envelopes).toHaveLength(0);
    expect((await e.handle({ action: "signal", runId: "c", actionId: "legal.approve:CTR-2026-0042", value: "approve", userId: "U_SALES_REP" })).status).toBe(403);
    await e.handle({ action: "signal", runId: "c", actionId: "legal.approve:CTR-2026-0042", value: "approve", userId: "U_LAWYER" });
    expect(w.state.docusign.envelopes).toHaveLength(1);
    clock.t = NOW + 30 * DAY + 1;
    await e.handle({ action: "tick" });
    expect(w.state.docusign.envelopes[0]).toMatchObject({ status: "voided", voidedReason: "Not signed within 30 days" });
  });

  it("an unusable model answer is never trusted: a lawyer reviews", async () => {
    w.state.openai.replies.push({ content: "Sample content", role: "system" });
    const r = await w.engine(contractIntake, { now: () => NOW }).handle({ action: "start", runId: "c", input: input(), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "review", deviations: ['clauses could not be extracted (answer came from role "system")'] });
    expect(w.state.docusign.envelopes).toHaveLength(0);
  });

  it("a rejected review sends nothing", async () => {
    w.state.openai.replies.push({ content: JSON.stringify(clauses({ flags: ["unilateral_indemnity"] })) });
    const e = w.engine(contractIntake, { now: () => NOW });
    await e.handle({ action: "start", runId: "c", input: input(), requestedBy: user });
    const r = await e.handle({ action: "signal", runId: "c", actionId: "legal.approve:CTR-2026-0042", value: "reject", userId: "U_LAWYER" });
    expect(action(r.body, "docusign.send:CTR-2026-0042").status).toBe("skipped");
    expect(r.body.phase).toBe("DONE");
  });
});
