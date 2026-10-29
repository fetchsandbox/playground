import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePolicy } from "../src/kit/policy";
import { providerFactory } from "../src/providers";
import { documentStore } from "../src/providers/storage";
import { latestCertificate, vendorComplianceDocs } from "../src/workflows/vendor-compliance-docs";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const DAY = 86_400_000;
const user = { userId: "U_PROCUREMENT_SYSTEM" };
const date = (days: number) => new Date(NOW + days * DAY).toISOString().slice(0, 10);
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const input = (over: object = {}) => ({ vendorId: "V-3301", vendor: { legalName: "Initech LLC", contactName: "Bill Lumbergh", contactEmail: "bill@initech.example" }, riskTier: "high", processesPersonalData: true, ...over });
const start = (runId = "v1", over: object = {}) => ({ action: "start" as const, runId, input: input(over), requestedBy: user });
const INS = "Vendors/Initech LLC (V-3301)/Insurance";

describe("vendor-compliance-docs", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
    w.state.slack.channels.add("C0PROCURE01");
  });
  afterEach(() => w.close());
  const box = () => documentStore(providerFactory(w.endpoints())({}), { provider: "box", root: "0" })!;
  const certificate = (expires: string) => box().put(INS, `COI ${expires}.pdf`, Buffer.from("%PDF-1.4 coi"));

  it("reads the latest certificate by its file name", () => {
    expect(latestCertificate(["COI 2026-03-01.pdf", "notes.txt", "COI 2027-03-01 renewal.pdf", "COI 2026-13-99.pdf"], "^COI (\\d{4}-\\d{2}-\\d{2})\\b")).toEqual({ expires: "2027-03-01", file: "COI 2027-03-01 renewal.pdf" });
  });

  it("sends the high-risk packet plus the DPA, files it on completion, and schedules certificate notices", async () => {
    await certificate(date(90));
    const e = w.engine(vendorComplianceDocs, { now: () => NOW });
    const r = await e.handle(start());
    expect(r.body.output).toEqual({ onboarding: "sent", insurance: "tracked", insuranceRequired: true, certificateExpires: date(90) });
    const env = w.state.docusign.envelopes[0];
    expect(env.templateIds).toEqual(["w9-template-id", "vendor-msa-template-id", "security-addendum-template-id", "dpa-template-id"]);
    expect(env.signers.map((s: any) => s.roleName)).toEqual(["Vendor", "Procurement"]);
    expect(r.body.actions.filter((a: any) => a.kind === "procurement.coi_notice").map((a: any) => [a.id, a.status])).toEqual([["procurement.coi_notice:60", "scheduled"], ["procurement.coi_notice:30", "scheduled"], ["procurement.coi_notice:7", "scheduled"]]);
    expect(action(r.body, "gmail.coi_renewal_request").status).toBe("scheduled");

    Object.assign(env, { status: "completed", completedDateTime: `${date(2)}T09:00:00Z` });
    const done = await e.handle({ action: "signal", runId: "v1", actionId: "docusign.onboarding_completed", value: "approve", userId: "docusign-connect" });
    expect(action(done.body, "docusign.onboarding_completed")).toMatchObject({ status: "applied", detail: { path: `Vendors/Initech LLC (V-3301)/Onboarding/${date(2)} Onboarding documents - Initech LLC.pdf` } });
  });

  it("low-risk vendors without personal data get the standard packet and no DPA; insurance is optional", async () => {
    const r = await w.engine(vendorComplianceDocs, { now: () => NOW }).handle(start("v1", { riskTier: "low", processesPersonalData: false }));
    expect(w.state.docusign.envelopes[0].templateIds).toEqual(["w9-template-id", "vendor-terms-template-id"]);
    expect(r.body.output).toMatchObject({ insurance: "missing", insuranceRequired: false });
    expect(action(r.body, "procurement.coi_missing")).toBeUndefined();
  });

  it("a required certificate that is missing is raised at once", async () => {
    const r = await w.engine(vendorComplianceDocs, { now: () => NOW }).handle(start("v1", { riskTier: "medium" }));
    expect(action(r.body, "procurement.coi_missing").status).toBe("applied");
    expect(w.state.slack.messages.at(-1).text).toMatch(/medium-risk and has no certificate of insurance in Vendors\/Initech LLC \(V-3301\)\/Insurance/);
  });

  it("notices before expiry, a drafted renewal request at 30 days, and a hold notice on the expiry date", async () => {
    await certificate(date(40));
    const clock = { t: NOW };
    const e = w.engine(vendorComplianceDocs, { now: () => clock.t });
    const r = await e.handle(start("v1", { insuranceOnly: true }));
    expect(r.body.output.onboarding).toBe("not_requested");
    expect(action(r.body, "procurement.coi_notice:60")).toBeUndefined();
    clock.t = Date.parse(`${date(10)}T16:00:00Z`);
    await e.handle({ action: "tick" });
    expect(w.state.slack.messages.at(-1).text).toMatch(/expires .* \(30 days\)/);
    const draft = Buffer.from(w.state.gmail.drafts[0].message.raw, "base64url").toString();
    expect(draft).toMatch(/To: bill@initech.example/);
    expect(draft).toContain(`expires on ${date(40)}`);
    clock.t = Date.parse(`${date(40)}T16:00:00Z`);
    await e.handle({ action: "tick" });
    expect(w.state.slack.messages.at(-1).text).toMatch(/expired today .* Hold new orders until one is\./);
  });

  it("a newer certificate filed in the folder stands every remaining insurance timer down", async () => {
    await certificate(date(40));
    const clock = { t: NOW };
    const e = w.engine(vendorComplianceDocs, { now: () => clock.t });
    await e.handle(start("v1", { insuranceOnly: true }));
    await certificate(date(400));
    clock.t = Date.parse(`${date(41)}T16:00:00Z`);
    await e.handle({ action: "tick" });
    const s = (await e.handle({ action: "status", runId: "v1" })).body;
    expect(s.actions.map((a: any) => a.status)).toEqual(["skipped", "skipped", "skipped", "skipped"]);
    expect(action(s, "procurement.coi_expired").detail.reason).toMatch(/renewed: certificate now expires/);
    expect(w.state.slack.messages).toHaveLength(0);
    expect(w.state.gmail.drafts).toHaveLength(0);
  });

  it("an expired certificate on a required tier is raised at once", async () => {
    await certificate(date(-3));
    const r = await w.engine(vendorComplianceDocs, { now: () => NOW }).handle(start("v1", { insuranceOnly: true }));
    expect(r.body.output.insurance).toBe("expired");
    expect(w.state.slack.messages.at(-1).text).toMatch(/expired .*Hold new orders/);
  });

  it("unsigned after 7 and 14 days, then declined: Procurement is told each time", async () => {
    await certificate(date(300));
    const clock = { t: NOW };
    const e = w.engine(vendorComplianceDocs, { now: () => clock.t });
    await e.handle(start());
    clock.t = NOW + 8 * DAY;
    await e.handle({ action: "tick" });
    expect(w.state.slack.messages.at(-1).text).toMatch(/hasn't signed its onboarding documents after 7 day/);
    await e.handle({ action: "signal", runId: "v1", actionId: "docusign.onboarding_completed", value: "reject", userId: "docusign-connect" });
    expect(w.state.slack.messages.at(-1).text).toMatch(/declined, voided, expired or couldn't be filed/);
    clock.t = NOW + 15 * DAY;
    await e.handle({ action: "tick" });
    expect(action((await e.handle({ action: "status", runId: "v1" })).body, "procurement.unsigned:14").status).toBe("skipped");
  });

  it("re-onboarding the same vendor reuses its envelope", async () => {
    const e = w.engine(vendorComplianceDocs, { now: () => NOW });
    await e.handle(start("v1"));
    const again = await e.handle(start("v2"));
    expect(again.body.output.onboarding).toBe("existing_envelope");
    expect(w.state.docusign.envelopes).toHaveLength(1);
  });

  it("DocuSign down: nothing sent; the insurance check still runs", async () => {
    await certificate(date(90));
    const r = await w.engine(vendorComplianceDocs, { now: () => NOW, only: ["slack", "box", "gmail"] }).handle(start());
    expect(r.body.output).toMatchObject({ onboarding: "blocked", insurance: "tracked" });
    expect(action(r.body, "slack.post_blocked").status).toBe("applied");
  });

  it("an unreadable Insurance folder is said out loud, never treated as 'no certificate'", async () => {
    w.faults.push({ method: "GET", path: /^\/folders\/\d+\/items$/, status: 500, body: { type: "error", code: "internal_server_error" } });
    const r = await w.engine(vendorComplianceDocs, { now: () => NOW, only: ["slack", "box"] }).handle(start("v1", { insuranceOnly: true }));
    expect(r.body.output.insurance).toBe("unreadable");
    expect(action(r.body, "procurement.coi_missing")).toBeUndefined();
    expect(w.state.slack.messages.at(-1).text).toMatch(/Insurance folder in box couldn't be read/);
  });

  it("a deployment can use Dropbox, other notice days and a different certificate naming, by policy only", async () => {
    const p = resolvePolicy(vendorComplianceDocs.policy!, { POLICY_JSON: JSON.stringify({ store: { provider: "dropbox", root: "/Procurement" }, insurance: { certificatePattern: "^Insurance-(\\d{4}-\\d{2}-\\d{2})", noticeDays: [14] } }) });
    await providerFactory(w.endpoints())({}).dropbox!.upload(`/Procurement/${INS}/Insurance-${date(60)}.pdf`, Buffer.from("%PDF"));
    const r = await w.engine(vendorComplianceDocs, { now: () => NOW, policy: p }).handle(start("v1", { insuranceOnly: true }));
    expect(r.body.output).toMatchObject({ insurance: "tracked", certificateExpires: date(60) });
    expect(r.body.actions.filter((a: any) => a.kind === "procurement.coi_notice").map((a: any) => a.id)).toEqual(["procurement.coi_notice:14"]);
  });

  it("rejects a certificate pattern without a capture group", () => {
    expect(() => resolvePolicy(vendorComplianceDocs.policy!, { POLICY_JSON: '{"insurance":{"certificatePattern":"^COI"}}' })).toThrow(/capture group/);
  });
});
