import { z } from "zod";
import { SkipAction } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import type { Providers } from "../providers";
import type { BoxSharedLink } from "../providers/work";
import type { DropboxSharedLink } from "../providers/storage";
import defaults from "../../policies/external-sharing-audit.json";
import { DAY } from "./lib/documents";
import { Approvers, out } from "./shared";

// Security · data-protection.
// Trigger: a scheduled sweep (weekly by default) or an on-demand audit.
// Every shared link in Box and Dropbox is inventoried and checked against the
// sharing policy:
//   - a public link to a file whose name looks sensitive (payroll, passports,
//     customer exports…) is restricted to the company, or revoked;
//   - a public link with no expiry, or one further out than the policy allows,
//     gets the maximum expiry;
//   - company-only, collaborator-only and (by policy) password links are fine;
//     exempt folders (a press kit, public marketing) are skipped.
// Each change re-reads the link first and stands down if it changed since the
// sweep. Revoking, and anything past the per-run automatic limit, waits for a
// security approver. A source that can't be read is reported as not audited,
// never as clean. Patterns, limits, exemptions and remediations are policy
// (policies/external-sharing-audit.json).

const REMEDIES = ["restrict", "set_expiry", "revoke", "report"] as const;
type Remedy = (typeof REMEDIES)[number];

export const Policy = z.object({
  sources: z
    .object({
      box: z.object({ enabled: z.boolean(), rootFolders: z.array(z.string().regex(/^\d+$/, "Box folder id")).min(1).describe('Folders to sweep ("0" is everything the token can see)'), maxItems: z.number().int().min(1).max(200_000).describe("Stop after this many items; the run then says the sweep was partial") }),
      dropbox: z.object({ enabled: z.boolean() }),
    })
    .describe("Which stores to audit"),
  exemptPaths: z.array(z.string().min(1)).describe("Path prefixes (below the root, case-insensitive) whose links are allowed to be public"),
  publicMaxDays: z.number().int().min(1).max(365).describe("Longest a public link may stay up"),
  passwordCountsAsRestricted: z.boolean().describe("Treat a password-protected public link as restricted"),
  sensitivePatterns: z
    .array(z.string().refine((p) => { try { new RegExp(p, "i"); return true; } catch { return false; } }, "invalid regular expression"))
    .describe("Case-insensitive patterns on the item path; a match makes a public link sensitive"),
  remediation: z
    .object({
      sensitivePublic: z.enum(REMEDIES).describe("Public link to a sensitive item"),
      publicNoExpiry: z.enum(REMEDIES).describe("Public link without an expiry"),
      publicExpiryTooLong: z.enum(REMEDIES).describe("Public link expiring later than publicMaxDays"),
      approvalFor: z.array(z.enum(REMEDIES)).describe("Remedies that always wait for a security approver"),
      autoLimit: z.number().int().min(0).max(1000).describe("Automatic changes per run; the rest wait for approval"),
    })
    .describe("What to do about each finding"),
  securityChannel: z.string().regex(/^[CG][A-Z0-9]{6,}$/).describe("Slack channel for the audit summary"),
  reportTop: z.number().int().min(0).max(50).describe("Findings listed in the summary"),
});
export type Policy = z.infer<typeof Policy>;

const Input = z.object({
  auditId: z.string().regex(/^SHARE-[\w-]{3,40}$/, "audit id like SHARE-2026-W44"),
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

/** One shared link, normalized across Box and Dropbox. */
export interface Link {
  source: "box" | "dropbox";
  /** Box: "file:<id>" / "folder:<id>". Dropbox: the link URL (its identity for modify/revoke). */
  key: string;
  path: string;
  url: string;
  public: boolean;
  expires: string | null;
}
export interface Inventory {
  links: Link[];
  scanned: number;
  partial: boolean;
}
export interface Finding {
  link: Link;
  rule: "sensitive_public" | "public_no_expiry" | "public_expiry_too_long";
  remedy: Remedy;
}

export const boxIsPublic = (l: BoxSharedLink, p: Policy) => (l.effective_access ?? l.access) === "open" && !(p.passwordCountsAsRestricted && l.is_password_enabled);
export const dropboxIsPublic = (l: DropboxSharedLink, p: Policy) => {
  const v = l.link_permissions?.resolved_visibility?.[".tag"] ?? "public";
  return v === "public" || (v === "password" && !p.passwordCountsAsRestricted);
};

/** Pure: the policy's verdict on one link. */
export function assess(link: Link, p: Policy, now: number): Finding | null {
  if (!link.public) return null;
  const path = link.path.toLowerCase();
  if (p.exemptPaths.some((e) => path === e.toLowerCase() || path.startsWith(`${e.toLowerCase()}/`))) return null;
  if (p.sensitivePatterns.some((s) => new RegExp(s, "i").test(link.path))) return { link, rule: "sensitive_public", remedy: p.remediation.sensitivePublic };
  if (!link.expires) return { link, rule: "public_no_expiry", remedy: p.remediation.publicNoExpiry };
  if (Date.parse(link.expires) > now + p.publicMaxDays * DAY) return { link, rule: "public_expiry_too_long", remedy: p.remediation.publicExpiryTooLong };
  return null;
}

/** Box: walk folders breadth-first, collecting items that carry a shared link. */
async function boxLinks(providers: Providers, p: Policy): Promise<Inventory> {
  const box = providers.box!;
  const links: Link[] = [];
  const queue: { id: string; path: string }[] = p.sources.box.rootFolders.map((id) => ({ id, path: "" }));
  let scanned = 0;
  while (queue.length) {
    const dir = queue.shift()!;
    for (const item of await box.folderItems(dir.id, "name,type,shared_link")) {
      if (++scanned > p.sources.box.maxItems) return { links, scanned: scanned - 1, partial: true };
      const path = dir.path ? `${dir.path}/${item.name}` : item.name;
      if (item.type === "folder") queue.push({ id: item.id, path });
      if (item.shared_link && (item.type === "file" || item.type === "folder")) links.push({ source: "box", key: `${item.type}:${item.id}`, path, url: item.shared_link.url, public: boxIsPublic(item.shared_link, p), expires: item.shared_link.unshared_at ?? null });
    }
  }
  return { links, scanned, partial: false };
}

async function dropboxLinks(providers: Providers, p: Policy): Promise<Inventory> {
  const all = await providers.dropbox!.listSharedLinks();
  // Links Dropbox returns without a path are other people's content shared with this account: not ours to change.
  const links = all.filter((l) => l.path_lower).map((l): Link => ({ source: "dropbox", key: l.url, path: l.path_lower!.replace(/^\//, ""), url: l.url, public: dropboxIsPublic(l, p), expires: l.expires ?? null }));
  return { links, scanned: all.length, partial: false };
}

export const externalSharingAudit: WorkflowDef<Input> = {
  id: "external-sharing-audit",
  title: "External sharing audit",
  org: "Security",
  team: "data-protection",
  description:
    "Inventory every shared link in Box and Dropbox and enforce the sharing policy: restrict public links to sensitive items, give public links a maximum expiry, skip exempt folders; each change re-reads the link first, revocations and changes past the per-run limit need a security approver, and a store that can't be read is reported as not audited; patterns, limits and remedies are policy.",
  input: Input,
  policy: { schema: Policy as z.ZodType<unknown>, defaults },
  audit: true,
  agents: [
    {
      name: "box-links",
      needs: ["box"],
      async run({ providers, policy }) {
        const p = policy as Policy;
        if (!p.sources.box.enabled) return { summary: "disabled by policy", data: null };
        const inv = await boxLinks(providers, p);
        return { summary: `${inv.links.length} shared link(s) in ${inv.scanned} item(s)${inv.partial ? " (partial: item limit reached)" : ""}`, data: inv };
      },
    },
    {
      name: "dropbox-links",
      needs: ["dropbox"],
      async run({ providers, policy }) {
        const p = policy as Policy;
        if (!p.sources.dropbox.enabled) return { summary: "disabled by policy", data: null };
        const inv = await dropboxLinks(providers, p);
        return { summary: `${inv.links.length} shared link(s)`, data: inv };
      },
    },
  ],

  plan({ input, policy, startedAt }, results) {
    const p = policy as Policy;
    const now = startedAt.getTime();
    const sources = { box: out<Inventory | null>(results, "box-links"), dropbox: out<Inventory | null>(results, "dropbox-links") };
    const findings = Object.values(sources).flatMap((inv) => (inv ? inv.links : [])).map((l) => assess(l, p, now)).filter((f): f is Finding => !!f);
    const expiry = new Date(now + p.publicMaxDays * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");
    let auto = 0;
    const actions: PlannedAction<Input>[] = [];
    for (const f of findings.filter((x) => x.remedy !== "report")) {
      const needsApproval = p.remediation.approvalFor.includes(f.remedy) || auto >= p.remediation.autoLimit;
      if (!needsApproval) auto++;
      actions.push({
        id: `sharing.${f.remedy}:${f.link.source}:${f.link.key}`,
        kind: `sharing.${f.remedy}`,
        provider: f.link.source,
        agent: `${f.link.source}-links`,
        gate: needsApproval ? "approval" : "auto",
        summary: { source: f.link.source, path: f.link.path, rule: f.rule, ...(f.remedy === "set_expiry" ? { expires: expiry } : {}) },
        async execute({ providers }) {
          return remediate(providers, f, expiry, p);
        },
        async reconcile({ providers }) {
          const cur = await currentLink(providers, f.link, p);
          const ok = f.remedy === "revoke" ? !cur : f.remedy === "restrict" ? !!cur && !cur.public : !!cur && !!cur.expires && Date.parse(cur.expires) <= Date.parse(expiry) + 60_000;
          return ok ? { status: "match" } : { status: "drift", detail: `${f.link.path} is ${cur ? (cur.public ? "public" : "restricted") : "unshared"}${cur?.expires ? ` until ${cur.expires}` : ""} again` };
        },
      });
    }
    actions.push({
      id: "slack.post_audit",
      kind: "slack.post_audit",
      provider: "slack",
      agent: "box-links",
      gate: "auto",
      summary: { auditId: input.auditId, findings: findings.length },
      async execute({ providers }) {
        const line = (name: string, inv: Inventory | null | undefined) => (inv === undefined ? `${name}: *not audited* (couldn't be read)` : inv === null ? `${name}: disabled by policy` : `${name}: ${inv.links.length} link(s) in ${inv.scanned} item(s)${inv.partial ? ", *partial*: item limit reached" : ""}`);
        const top = findings.slice(0, p.reportTop).map((f) => `• ${f.link.source} ${f.link.path}: ${f.rule.replaceAll("_", " ")} → ${f.remedy}`);
        const gated = actions.filter((a) => a.gate === "approval").length;
        const text = [`:lock: ${input.auditId}: ${findings.length} sharing finding(s); ${auto} fixed automatically, ${gated} waiting for approval, ${findings.filter((f) => f.remedy === "report").length} reported only.`, line("Box", sources.box), line("Dropbox", sources.dropbox), ...top].join("\n");
        return { ref: (await providers.slack!.postMessage(p.securityChannel, text)).ts };
      },
    });
    return actions;
  },

  output({ policy, startedAt }, results) {
    const p = policy as Policy;
    const box = out<Inventory | null>(results, "box-links");
    const dropbox = out<Inventory | null>(results, "dropbox-links");
    const findings = [box, dropbox].flatMap((inv) => (inv ? inv.links : [])).map((l) => assess(l, p, startedAt.getTime())).filter(Boolean) as Finding[];
    const status = (inv: Inventory | null | undefined) => (inv === undefined ? "not_audited" : inv === null ? "disabled" : inv.partial ? "partial" : "complete");
    return { mode: "audit", box: status(box), dropbox: status(dropbox), links: [box, dropbox].reduce((n, inv) => n + (inv?.links.length ?? 0), 0), findings: findings.length, sensitive: findings.filter((f) => f.rule === "sensitive_public").length };
  },

  catalog: [
    { kind: "sharing.restrict", provider: "box", gate: "auto", description: "Public link to a sensitive item: restricted to the company (Box) or team (Dropbox)" },
    { kind: "sharing.set_expiry", provider: "box", gate: "auto", description: "Public link without, or past, the maximum expiry: set to the policy's maximum" },
    { kind: "sharing.revoke", provider: "box", gate: "approval", description: "Remove the link entirely (approval by default)" },
    { kind: "slack.post_audit", provider: "slack", gate: "auto", description: "Audit summary: findings, what was fixed, what waits, and which sources weren't audited" },
  ],
};

/** The link as it is now, re-read from its store (null when it no longer exists). */
async function currentLink(providers: Providers, link: Link, p: Policy): Promise<Link | null> {
  if (link.source === "box") {
    const [type, id] = link.key.split(":") as ["file" | "folder", string];
    const l = await providers.box!.getSharedLink(type, id);
    return l ? { ...link, url: l.url, public: boxIsPublic(l, p), expires: l.unshared_at ?? null } : null;
  }
  const l = (await providers.dropbox!.listSharedLinks(`/${link.path}`)).find((x) => x.url === link.url);
  return l ? { ...link, public: dropboxIsPublic(l, p), expires: l.expires ?? null } : null;
}

async function remediate(providers: Providers, f: Finding, expiry: string, p: Policy) {
  const cur = await currentLink(providers, f.link, p);
  // Someone fixed or changed it since the sweep: their change wins.
  if (!cur) throw new SkipAction("link no longer exists");
  if (cur.url !== f.link.url) throw new SkipAction("link was replaced since the audit");
  if (!cur.public) throw new SkipAction("link is no longer public");
  if (f.remedy === "set_expiry" && cur.expires && Date.parse(cur.expires) <= Date.parse(expiry)) throw new SkipAction(`already expires ${cur.expires}`);
  if (f.link.source === "box") {
    const [type, id] = f.link.key.split(":") as ["file" | "folder", string];
    if (f.remedy === "revoke") await providers.box!.setSharedLink(type, id, null);
    else if (f.remedy === "restrict") await providers.box!.setSharedLink(type, id, { access: "company" });
    else await providers.box!.setSharedLink(type, id, { access: "open", unshared_at: expiry });
  } else {
    if (f.remedy === "revoke") await providers.dropbox!.revokeSharedLink(f.link.url);
    else if (f.remedy === "restrict") await providers.dropbox!.modifySharedLink(f.link.url, { audience: "team" });
    else await providers.dropbox!.modifySharedLink(f.link.url, { expires: expiry });
  }
  return { ref: f.link.key, detail: { path: f.link.path, was: { public: true, expires: cur.expires } } };
}
