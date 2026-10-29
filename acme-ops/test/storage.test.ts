import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { providerFactory } from "../src/providers";
import { documentStore, headerJson, safeName } from "../src/providers/storage";
import { startWorld, type World } from "./fake-world";

const pdf = (s: string) => Buffer.from(`%PDF-1.4 ${s}`);

describe("document stores (Box and Dropbox)", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
  });
  afterEach(() => w.close());
  const providers = () => providerFactory(w.endpoints())({});

  it("Box: creates the folder path once, files the bytes, and never overwrites", async () => {
    const store = documentStore(providers(), { provider: "box", root: "0" })!;
    const a = await store.put("Legal/Agreements/2026", "MSA - Globex.pdf", pdf("one"));
    expect(a).toMatchObject({ provider: "box", name: "MSA - Globex.pdf", path: "Legal/Agreements/2026", existed: false });
    expect(w.state.box.folders.map((f) => f.name)).toEqual(["Legal", "Agreements", "2026"]);
    expect(w.state.box.files.find((f) => f.id === a.id)?.content).toBe("%PDF-1.4 one");
    // Many siblings force marker paging; a retry finds the file instead of uploading again.
    for (const n of ["a", "b", "c"]) await store.put("Legal/Agreements/2026", `${n}.pdf`, pdf(n));
    const again = await store.put("Legal/Agreements/2026", "MSA - Globex.pdf", pdf("two"));
    expect(again).toMatchObject({ id: a.id, existed: true });
    expect(w.state.box.folders).toHaveLength(3);
    expect(await store.find("Legal/Agreements/2026", "MSA - Globex.pdf")).toMatchObject({ id: a.id });
    expect(await store.find("Legal/Nope", "x.pdf")).toBeNull();
    expect((await store.list("Legal/Agreements/2026")).map((d) => d.name).sort()).toEqual(["MSA - Globex.pdf", "a.pdf", "b.pdf", "c.pdf"]);
    expect(await store.list("Legal")).toEqual([]);
    expect(await store.list("Nope/Nothing")).toEqual([]);
  });

  it("Dropbox: uploads with the arguments in Dropbox-API-Arg, header-safe, and treats a conflict as already filed", async () => {
    const store = documentStore(providers(), { provider: "dropbox", root: "/Acme" })!;
    const a = await store.put("Legal/Agreements/2026", "Contrato – Müller.pdf", pdf("one"));
    expect(a).toMatchObject({ provider: "dropbox", name: "Contrato – Müller.pdf", existed: false });
    expect(a.id).toMatch(/^id:/);
    const up = w.requests.find((r) => r.path === "/2/files/upload")!;
    expect(up.headers["content-type"]).toBe("application/octet-stream");
    expect(String(up.headers["dropbox-api-arg"])).toContain("\\u00fc");
    expect(JSON.parse(String(up.headers["dropbox-api-arg"]))).toEqual({ path: "/Acme/Legal/Agreements/2026/Contrato – Müller.pdf", mode: "add", autorename: false, mute: true, strict_conflict: true });
    const again = await store.put("Legal/Agreements/2026", "Contrato – Müller.pdf", pdf("two"));
    expect(again).toMatchObject({ id: a.id, existed: true });
    const dl = await providers().dropbox!.downloadBase64(a.id);
    expect(Buffer.from(dl.base64, "base64").toString()).toBe("%PDF-1.4 one");
    expect(dl.metadata?.name).toBe("Contrato – Müller.pdf");
    await store.put("Legal/Agreements/2026/Old", "x.pdf", pdf("x"));
    expect((await store.list("Legal/Agreements/2026")).map((d) => d.name)).toEqual(["Contrato – Müller.pdf"]);
    expect(await store.list("Nope")).toEqual([]);
  });

  it("Dropbox: list_folder and list_shared_links follow their cursors; links can be narrowed and revoked", async () => {
    const dbx = providers().dropbox!;
    for (const n of ["a", "b", "c", "d", "e"]) await dbx.upload(`/Share/${n}.pdf`, pdf(n));
    expect((await dbx.listFolder("/Share")).map((e) => e.name)).toEqual(["a.pdf", "b.pdf", "c.pdf", "d.pdf", "e.pdf"]);
    w.state.dropbox.links.push(
      ...["a", "b", "c"].map((n) => ({ ".tag": "file", url: `https://www.dropbox.com/scl/fi/${n}`, name: `${n}.pdf`, path_lower: `/share/${n}.pdf`, link_permissions: { resolved_visibility: { ".tag": "public" } } })),
    );
    const links = await dbx.listSharedLinks();
    expect(links).toHaveLength(3);
    const narrowed = await dbx.modifySharedLink(links[0]!.url, { expires: "2026-11-13T12:00:00.000Z", audience: "team" });
    expect(narrowed).toMatchObject({ expires: "2026-11-13T12:00:00Z", link_permissions: { resolved_visibility: { ".tag": "team_only" } } });
    await dbx.revokeSharedLink(links[1]!.url);
    expect(await dbx.listSharedLinks()).toHaveLength(2);
    expect(await dbx.getMetadata("/Share/zzz.pdf")).toBeNull();
  });

  it("Box: shared links on files and folders can be narrowed or removed", async () => {
    const box = providers().box!;
    const f = await box.uploadBytes("0", "deck.pdf", pdf("deck"));
    await box.createSharedLink(f.id, "2027-01-01T00:00:00Z");
    expect(await box.setSharedLink("file", f.id, { access: "company", unshared_at: "2026-11-01T00:00:00Z" })).toMatchObject({ access: "company", unshared_at: "2026-11-01T00:00:00Z" });
    expect(await box.setSharedLink("file", f.id, null)).toBeNull();
    const items = await box.folderItems("0", "name,type,shared_link");
    expect(items.find((i) => i.id === f.id)?.shared_link).toBeNull();
  });

  it("names and header JSON are safe for both stores", () => {
    expect(safeName('Acme / Globex: "MSA" <v2>')).toBe("Acme Globex MSA v2");
    expect(headerJson({ path: "/é" })).toBe('{"path":"/\\u00e9"}');
  });
});

describe("DocuSign templates and completed documents", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
  });
  afterEach(() => w.close());

  it("sends composite templates with roles and native reminders, then reads details, form data and the combined PDF", async () => {
    const ds = providerFactory(w.endpoints())({}).docusign!;
    const sent = await ds.createFromTemplates({ subject: "Your offer documents", templateIds: ["tpl-offer", "tpl-nda"], roles: [{ roleName: "Employee", email: "new@acme.example", name: "New Hire" }], externalId: "nh-1", reminders: { delayDays: 2, everyDays: 3 }, expireDays: 14 });
    const body = w.requests.find((r) => r.method === "POST" && r.path.endsWith("/envelopes"))!.body;
    expect(body.compositeTemplates).toHaveLength(2);
    expect(body.compositeTemplates[1]).toMatchObject({ compositeTemplateId: "2", serverTemplates: [{ sequence: "1", templateId: "tpl-nda" }], inlineTemplates: [{ sequence: "2", recipients: { signers: [{ roleName: "Employee", recipientId: "1" }] } }] });
    expect(body.notification).toEqual({ useAccountDefaults: "false", reminders: { reminderEnabled: "true", reminderDelay: "2", reminderFrequency: "3" }, expirations: { expireEnabled: "true", expireAfter: "14", expireWarn: "3" } });
    const env = w.state.docusign.envelopes[0];
    env.status = "completed";
    env.formData = [{ name: "agreement_type", value: "MSA" }];
    const detail = await ds.getEnvelopeDetail(sent.envelopeId);
    expect(detail.customFields?.textCustomFields).toContainEqual({ name: "acme_external_id", value: "nh-1" });
    expect(await ds.formData(sent.envelopeId)).toEqual({ agreement_type: "MSA" });
    expect(Buffer.from(await ds.combinedPdfBase64(sent.envelopeId), "base64").toString()).toBe(`%PDF-1.4 ${sent.envelopeId} certificate=true`);
    expect(await ds.listChanged("2026-10-01T00:00:00Z", "completed")).toHaveLength(1);
  });
});
