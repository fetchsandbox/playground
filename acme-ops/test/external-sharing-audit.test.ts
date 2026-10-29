import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePolicy } from "../src/kit/policy";
import { assess, externalSharingAudit, type Policy } from "../src/workflows/external-sharing-audit";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const DAY = 86_400_000;
const user = { userId: "U_SECURITY_SCHEDULER" };
const iso = (days: number) => new Date(NOW + days * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const start = (runId = "s1", over: object = {}) => ({ action: "start" as const, runId, input: { auditId: "SHARE-2026-W42", approvers: ["U_SECLEAD"], ...over }, requestedBy: user });
const policy = externalSharingAudit.policy!.defaults as Policy;

describe("external-sharing-audit", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
    w.state.slack.channels.add("C0SECURITY1");
    // Box: Finance/Payroll/payroll-2026-10.csv (public, no expiry), Sales/deck.pdf (public, 200 days),
    // Press Kit/logo.png (public, exempt), Legal/msa.pdf (company only), and a public folder link.
    const B = w.state.box;
    B.folders.push({ id: "100", name: "Finance", parent: "0" }, { id: "101", name: "Payroll", parent: "100" }, { id: "200", name: "Sales", parent: "0" }, { id: "300", name: "Press Kit", parent: "0" }, { id: "400", name: "Legal", parent: "0" });
    B.folders.find((f) => f.id === "200")!.sharedLink = { url: "https://acme.app.box.com/s/sales", access: "open", unshared_at: iso(10) };
    B.files.push(
      { id: "9001", name: "payroll-2026-10.csv", text: null, folder: "101", sharedLink: { url: "https://acme.app.box.com/s/payroll", access: "open", unshared_at: null as any } },
      { id: "9002", name: "deck.pdf", text: null, folder: "200", sharedLink: { url: "https://acme.app.box.com/s/deck", access: "open", unshared_at: iso(200) } },
      { id: "9003", name: "logo.png", text: null, folder: "300", sharedLink: { url: "https://acme.app.box.com/s/logo", access: "open", unshared_at: null as any } },
      { id: "9004", name: "msa.pdf", text: null, folder: "400", sharedLink: { url: "https://acme.app.box.com/s/msa", access: "company", unshared_at: null as any } },
    );
    // Dropbox: a public customer export, a team-only doc, a password link, and someone else's link (no path).
    w.state.dropbox.links.push(
      { ".tag": "file", url: "https://www.dropbox.com/scl/fi/exp", name: "customer_export.csv", path_lower: "/ops/customer_export.csv", link_permissions: { resolved_visibility: { ".tag": "public" } } },
      { ".tag": "file", url: "https://www.dropbox.com/scl/fi/team", name: "plan.docx", path_lower: "/ops/plan.docx", link_permissions: { resolved_visibility: { ".tag": "team_only" } } },
      { ".tag": "file", url: "https://www.dropbox.com/scl/fi/pw", name: "brief.pdf", path_lower: "/ops/brief.pdf", link_permissions: { resolved_visibility: { ".tag": "password" } } },
      { ".tag": "file", url: "https://www.dropbox.com/scl/fi/theirs", name: "their.pdf", link_permissions: { resolved_visibility: { ".tag": "public" } } },
    );
  });
  afterEach(() => w.close());
  const boxLink = (id: string) => w.state.box.files.find((f) => f.id === id)?.sharedLink;

  it("finds what the policy forbids across Box and Dropbox, fixes it, and says what it did", async () => {
    const r = await w.engine(externalSharingAudit, { now: () => NOW }).handle(start());
    expect(r.body.output).toEqual({ mode: "audit", box: "complete", dropbox: "complete", links: 8, findings: 3, sensitive: 2 });
    // Sensitive and public → restricted to the company / team.
    expect(boxLink("9001")).toMatchObject({ access: "company" });
    expect(w.state.dropbox.links[0].link_permissions.resolved_visibility[".tag"]).toBe("team_only");
    // Public past the 30-day maximum (file and folder) → expiry set to the maximum.
    expect(boxLink("9002")).toMatchObject({ access: "open", unshared_at: iso(30) });
    expect(action(r.body, "sharing.set_expiry:box:folder:200")).toBeUndefined(); // folder link expires in 10 days: fine
    // Exempt, company-only, password, team-only and other people's links are left alone.
    expect(boxLink("9003")).toMatchObject({ access: "open", unshared_at: null });
    expect(boxLink("9004")).toMatchObject({ access: "company" });
    const text = w.state.slack.messages.at(-1).text;
    expect(text).toMatch(/SHARE-2026-W42: 3 sharing finding\(s\); 3 fixed automatically, 0 waiting for approval/);
    expect(text).toContain("• box Finance/Payroll/payroll-2026-10.csv: sensitive public → restrict");
    expect(r.body.actions.filter((a: any) => a.status === "applied")).toHaveLength(4); // 3 fixes + the summary
    // A password-protected link counts as restricted under the default policy.
    expect(r.body.actions.some((a: any) => a.id.includes("/pw"))).toBe(false);
  });

  it("never overrides a change someone made after the sweep", async () => {
    const e = w.engine(externalSharingAudit, { now: () => NOW, policy: resolvePolicy(externalSharingAudit.policy!, { POLICY_JSON: '{"remediation":{"autoLimit":0}}' }) });
    const r = await e.handle(start());
    expect(r.body.phase).toBe("AWAITING_APPROVAL");
    expect(boxLink("9001")).toMatchObject({ access: "open" });
    // The owner fixes the payroll link themselves, and replaces the deck's link, before approval.
    boxLink("9001")!.access = "collaborators";
    boxLink("9002")!.url = "https://acme.app.box.com/s/deck-v2";
    const done = await e.handle({ action: "decide", runId: "s1", decision: "approve", userId: "U_SECLEAD" });
    expect(action(done.body, "sharing.restrict:box:file:9001")).toMatchObject({ status: "skipped", detail: { reason: "link is no longer public" } });
    expect(action(done.body, "sharing.set_expiry:box:file:9002")).toMatchObject({ status: "skipped", detail: { reason: "link was replaced since the audit" } });
    expect(boxLink("9001")).toMatchObject({ access: "collaborators" });
  });

  it("revocation and anything past the automatic limit wait for a security approver", async () => {
    const p = resolvePolicy(externalSharingAudit.policy!, { POLICY_JSON: '{"remediation":{"sensitivePublic":"revoke","autoLimit":1}}' });
    const e = w.engine(externalSharingAudit, { now: () => NOW, policy: p });
    const r = await e.handle(start());
    expect(r.body.actions.filter((a: any) => a.gate === "approval").map((a: any) => a.id).sort()).toEqual(["sharing.revoke:box:file:9001", "sharing.revoke:dropbox:https://www.dropbox.com/scl/fi/exp"]);
    expect(action(r.body, "sharing.set_expiry:box:file:9002")).toMatchObject({ gate: "auto", status: "applied" });
    expect(boxLink("9001")).toBeDefined();
    expect(w.state.slack.messages.at(-1).text).toMatch(/3 sharing finding\(s\); 1 fixed automatically, 2 waiting for approval/);
    expect((await e.handle({ action: "decide", runId: "s1", decision: "approve", userId: "U_SOMEONE" })).status).toBe(403);
    await e.handle({ action: "decide", runId: "s1", decision: "approve", userId: "U_SECLEAD" });
    expect(boxLink("9001")).toBeUndefined();
    expect(w.state.dropbox.links.some((l) => l.url.endsWith("/exp"))).toBe(false);
  });

  it("a store that can't be read is 'not audited', never clean", async () => {
    w.faults.push({ method: "POST", path: /^\/2\/sharing\/list_shared_links$/, status: 401, body: { error_summary: "invalid_access_token/.." } });
    const r = await w.engine(externalSharingAudit, { now: () => NOW }).handle(start());
    expect(r.body.output).toMatchObject({ box: "complete", dropbox: "not_audited" });
    expect(w.state.slack.messages.at(-1).text).toContain("Dropbox: *not audited* (couldn't be read)");
  });

  it("an item limit makes the sweep partial and says so", async () => {
    const p = resolvePolicy(externalSharingAudit.policy!, { POLICY_JSON: '{"sources":{"box":{"maxItems":3},"dropbox":{"enabled":false}}}' });
    const r = await w.engine(externalSharingAudit, { now: () => NOW, policy: p }).handle(start());
    expect(r.body.output).toMatchObject({ box: "partial", dropbox: "disabled" });
    expect(w.state.slack.messages.at(-1).text).toMatch(/Box: .* \*partial\*: item limit reached\nDropbox: disabled by policy/);
  });

  it("re-running the same audit changes nothing twice; reconcile spots a link re-opened afterwards", async () => {
    const e = w.engine(externalSharingAudit, { now: () => NOW });
    await e.handle(start("s1"));
    const again = await e.handle(start("s2", { auditId: "SHARE-2026-W43" }));
    expect(again.body.output.findings).toBe(0);
    boxLink("9001")!.access = "open";
    const rec = await e.handle({ action: "reconcile", runId: "s1" });
    expect(action(rec.body, "sharing.restrict:box:file:9001").reconciled).toBe("drift");
  });

  it("the policy decides what is sensitive, exempt and how long links may live", () => {
    const link = { source: "box" as const, key: "file:1", path: "HR/Passport scans/jane.pdf", url: "u", public: true, expires: null };
    expect(assess(link, policy, NOW)).toMatchObject({ rule: "sensitive_public", remedy: "restrict" });
    expect(assess({ ...link, path: "Press Kit/jane.pdf" }, policy, NOW)).toBeNull();
    expect(assess({ ...link, path: "Docs/a.pdf", expires: iso(29) }, policy, NOW)).toBeNull();
    expect(assess({ ...link, path: "Docs/a.pdf", expires: iso(31) }, policy, NOW)).toMatchObject({ rule: "public_expiry_too_long" });
    expect(() => resolvePolicy(externalSharingAudit.policy!, { POLICY_JSON: '{"sensitivePatterns":["(unclosed"]}' })).toThrow(/invalid regular expression/);
  });
});
