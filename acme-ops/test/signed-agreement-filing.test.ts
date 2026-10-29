import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePolicy } from "../src/kit/policy";
import { signedAgreementFiling } from "../src/workflows/signed-agreement-filing";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const user = { userId: "U_DOCUSIGN_CONNECT" };
const ENV = "3f1c2b7a-5d4e-4c3b-9a8f-7e6d5c4b3a21";
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const envelope = (over: object = {}) => ({
  envelopeId: ENV,
  status: "completed",
  emailSubject: "Please sign: Master Services Agreement",
  completedDateTime: "2026-10-13T18:20:00Z",
  signers: [
    { email: "cfo@globex.com", name: "Hank Scorpio", status: "completed" },
    { email: "legal@acme.example", name: "Acme Legal", status: "completed" },
  ],
  textCustomFields: [{ name: "agreement_type", value: "MSA" }, { name: "counterparty", value: "Globex Corporation" }],
  ...over,
});
const start = (runId = "f1", over: object = {}) => ({ action: "start" as const, runId, input: { envelopeId: ENV, ...over }, requestedBy: user });
const policy = (json: object) => resolvePolicy(signedAgreementFiling.policy!, { POLICY_JSON: JSON.stringify(json) });

describe("signed-agreement-filing", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
    for (const c of ["C0LEGAL0001", "C0PRIVACY01", "C0REVOPS001"]) w.state.slack.channels.add(c);
  });
  afterEach(() => w.close());
  const boxFile = (name: string) => w.state.box.files.find((f) => f.name === name);
  const path = (id: string | undefined) => {
    const names: string[] = [];
    for (let f = w.state.box.folders.find((x) => x.id === id); f; f = w.state.box.folders.find((x) => x.id === f!.parent)) names.unshift(f.name);
    return names.join("/");
  };

  it("files a countersigned MSA with its certificate in the type's folder and tells Legal", async () => {
    w.state.docusign.envelopes.push(envelope());
    const r = await w.engine(signedAgreementFiling, { now: () => NOW }).handle(start());
    expect(r.body.output).toEqual({ mode: "filed", type: "MSA", typeSource: "custom_field", counterparty: "Globex Corporation", folder: "Legal/Agreements/Globex Corporation" });
    const name = `2026-10-13 MSA - Globex Corporation (${ENV}).pdf`;
    const f = boxFile(name)!;
    expect(f.content).toBe(`%PDF-1.4 ${ENV} certificate=true`);
    expect(path(f.folder)).toBe("Legal/Agreements/Globex Corporation");
    expect(w.state.slack.messages.at(-1)).toMatchObject({ channel: "C0LEGAL0001" });
    expect(w.state.slack.messages.at(-1).text).toMatch(/MSA with Globex Corporation is signed and filed in box: Legal\/Agreements\/Globex Corporation\//);
    expect(action(r.body, "slack.post_filing_failed").status).toBe("skipped");
    // The run keeps where the document went, never its bytes.
    expect(JSON.stringify(r.body)).not.toContain("%PDF");
    expect(r.body.policyVersion).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is idempotent by envelope: a second Connect delivery files nothing new", async () => {
    w.state.docusign.envelopes.push(envelope());
    const e = w.engine(signedAgreementFiling, { now: () => NOW });
    await e.handle(start("f1"));
    const again = await e.handle(start("f2"));
    expect(action(again.body, "storage.file_signed")).toMatchObject({ status: "applied", detail: { existed: true } });
    expect(w.state.box.files).toHaveLength(1);
    expect(w.requests.filter((r) => r.path.endsWith("/documents/combined"))).toHaveLength(1);
  });

  it("recognizes the type from the subject when no field says, and NDAs notify nobody", async () => {
    w.state.docusign.envelopes.push(envelope({ emailSubject: "Mutual Non-Disclosure Agreement", textCustomFields: [], signers: [{ email: "ceo@initech.io", name: "Bill", status: "completed" }] }));
    const r = await w.engine(signedAgreementFiling, { now: () => NOW }).handle(start());
    expect(r.body.output).toMatchObject({ mode: "filed", type: "NDA", typeSource: "subject", counterparty: "initech.io", folder: "Legal/NDAs/2026" });
    expect(action(r.body, "slack.notify_filed")).toBeUndefined();
    expect(w.state.slack.messages).toHaveLength(0);
  });

  it("never guesses an unknown type: files for review and tells Legal why", async () => {
    w.state.docusign.envelopes.push(envelope({ emailSubject: "Office lease", textCustomFields: [{ name: "agreement_type", value: "LEASE" }] }));
    const r = await w.engine(signedAgreementFiling, { now: () => NOW }).handle(start());
    expect(r.body.output).toMatchObject({ mode: "review", type: "UNCLASSIFIED", folder: "Legal/Needs filing review/2026" });
    expect(w.state.slack.messages.at(-1).text).toMatch(/needs filing review: agreement type "LEASE" isn't in the policy/);
  });

  it("an MSA without an internal countersignature is filed for review, not as executed", async () => {
    w.state.docusign.envelopes.push(envelope({ signers: [{ email: "cfo@globex.com", name: "Hank", status: "completed" }] }));
    const r = await w.engine(signedAgreementFiling, { now: () => NOW }).handle(start());
    expect(r.body.output).toMatchObject({ mode: "review", type: "MSA", folder: "Legal/Needs filing review/2026" });
    expect(w.state.slack.messages.at(-1).text).toMatch(/MSA has no countersignature from acme.example/);
  });

  it("ignores envelopes that aren't completed", async () => {
    w.state.docusign.envelopes.push(envelope({ status: "sent", completedDateTime: null }));
    const r = await w.engine(signedAgreementFiling, { now: () => NOW }).handle(start("f1", { event: "envelope-sent" }));
    expect(r.body.output).toEqual({ mode: "ignored", status: "sent" });
    expect(r.body.actions).toEqual([]);
    expect(w.requests.some((q) => q.path.endsWith("/form_data"))).toBe(false);
  });

  it("files to Dropbox when the deployment's policy says so, with no code change", async () => {
    w.state.docusign.envelopes.push(envelope());
    const p = policy({ store: { provider: "dropbox", root: "/Acme" }, types: { MSA: { folder: "Contracts/{counterparty}/{year}" } } });
    const r = await w.engine(signedAgreementFiling, { now: () => NOW, policy: p }).handle(start());
    expect(r.body.output).toMatchObject({ mode: "filed", folder: "Contracts/Globex Corporation/2026" });
    expect(w.state.dropbox.entries.find((e) => e.tag === "file")).toMatchObject({ path: `/Acme/Contracts/Globex Corporation/2026/2026-10-13 MSA - Globex Corporation (${ENV}).pdf`, content: `%PDF-1.4 ${ENV} certificate=true` });
    expect(w.state.box.files).toHaveLength(0);
    expect(r.body.policyVersion).toBe(p.version);
  });

  it("a counterparty name can't escape the folder layout", async () => {
    w.state.docusign.envelopes.push(envelope({ textCustomFields: [{ name: "agreement_type", value: "MSA" }, { name: "counterparty", value: "../../People/Payroll" }] }));
    const r = await w.engine(signedAgreementFiling, { now: () => NOW }).handle(start());
    expect(r.body.output.folder).toBe("Legal/Agreements/.. .. People Payroll");
    expect(w.state.box.folders.map((f) => f.name)).toEqual(["Legal", "Agreements", ".. .. People Payroll"]);
  });

  it("an unreadable envelope files nothing and Legal is told", async () => {
    const r = await w.engine(signedAgreementFiling, { now: () => NOW, only: ["slack", "box"] }).handle(start());
    expect(r.body.output).toEqual({ mode: "blocked" });
    expect(action(r.body, "slack.post_unreadable").status).toBe("applied");
    expect(w.state.box.files).toHaveLength(0);
  });

  it("a store that refuses the upload leaves Legal a note that the PDF is still only in DocuSign", async () => {
    w.state.docusign.envelopes.push(envelope());
    w.faults.push({ method: "POST", path: /^\/files\/content$/, status: 500, body: { type: "error", code: "internal_server_error" } });
    const r = await w.engine(signedAgreementFiling, { now: () => NOW }).handle(start());
    expect(action(r.body, "storage.file_signed").status).toBe("failed");
    expect(action(r.body, "slack.notify_filed").status).toBe("skipped");
    expect(action(r.body, "slack.post_filing_failed").status).toBe("applied");
    expect(w.state.slack.messages.at(-1).text).toMatch(/could not be filed in box .*still in DocuSign/);
  });

  it("refuses a policy whose subject rule names a type it doesn't file", () => {
    expect(() => policy({ classification: { subjectRules: [{ pattern: "lease", type: "LEASE" }] } })).toThrow(/maps to LEASE, which isn't in types/);
    expect(() => policy({ fileName: "{date} {tpye}.pdf" })).toThrow(/unknown placeholder\(s\) tpye/);
  });

  it("describe shows the policy so an operator or agent can change it", () => {
    const d = w.engine(signedAgreementFiling).describe() as any;
    expect(d.policy.values.store).toEqual({ provider: "box", root: "0" });
    expect(Object.keys(d.policy.schema.properties)).toContain("types");
  });

  it("reconcile notices a filed document that was deleted", async () => {
    w.state.docusign.envelopes.push(envelope());
    const e = w.engine(signedAgreementFiling, { now: () => NOW });
    await e.handle(start());
    w.state.box.files.length = 0;
    const r = await e.handle({ action: "reconcile", runId: "f1" });
    expect(action(r.body, "storage.file_signed").reconciled).toBe("missing");
  });
});
