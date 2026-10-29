import { z } from "zod";
import { SkipAction } from "../kit/errors";
import type { ActionContext, PlannedAction, WorkflowDef } from "../kit/types";
import type { Providers } from "../providers";
import defaults from "../../policies/vendor-compliance-docs.json";
import { DAY, fill, firstMatch, onDate, storeOf, StorePolicy, templateString } from "./lib/documents";
import { Email, messageId, out } from "./shared";

// Procurement · supplier-onboarding.
// Trigger: a new supplier is approved for onboarding (procurement system or
// vendor-master webhook), and again whenever its insurance certificate changes.
//   - Onboarding documents: one DocuSign envelope with the packet the vendor's
//     risk tier calls for (W-9, terms or MSA, security addendum), plus a DPA when
//     the vendor will process personal data, countersigned by Procurement.
//     Completion (DocuSign Connect, re-checked with DocuSign) files the signed
//     packet in the vendor's folder in Box or Dropbox. Procurement is told when
//     it is still unsigned after 7 and 14 days, and when it is declined.
//   - Certificate of insurance (COI): the vendor's Insurance folder is the
//     source of truth. Certificates are named "COI <expiry date>.pdf" (pattern in
//     policy). For tiers that require insurance, a missing or expired
//     certificate is raised at once; otherwise Procurement is told 60, 30 and 7
//     days before expiry, the vendor contact gets a renewal request (a Gmail
//     draft) at 30 days, and on the expiry date Procurement is told to hold
//     the vendor. Every insurance timer re-reads the folder and stands down
//     when a newer certificate has been filed.
// Packets, templates, cadence, folders, naming and notice days are policy
// (policies/vendor-compliance-docs.json).

const TIERS = ["low", "medium", "high"] as const;

export const Policy = z.object({
  store: StorePolicy,
  vendorFolder: templateString(["vendor", "vendorId"], "Vendor folder below the store root"),
  packets: z
    .array(z.object({ name: z.string().min(1), match: z.object({ riskTier: z.array(z.enum(TIERS)).optional() }), templates: z.array(z.string().min(1)).min(1).max(20).describe("DocuSign server template ids, in order") }))
    .min(1)
    .describe("Onboarding packets by risk tier; first match wins"),
  dpaTemplate: z.string().min(1).nullable().describe("Appended when the vendor will process personal data (null: never)"),
  signerRole: z.string().min(1).describe("Template role the vendor contact fills"),
  countersigner: z.object({ roleName: z.string().min(1), name: z.string().min(1), email: z.email() }).nullable().describe("Signs after the vendor (null: nobody)"),
  subject: templateString(["vendor"], "Envelope subject"),
  docusign: z.object({ reminderDelayDays: z.number().int().min(1).max(30), reminderEveryDays: z.number().int().min(1).max(30), expireDays: z.number().int().min(1).max(120) }).describe("DocuSign's own reminders and expiry"),
  connectSender: z.string().min(1).describe("User id your DocuSign Connect adapter signals completion as"),
  unsignedEscalateDays: z.array(z.number().int().min(1).max(120)).describe("Tell Procurement this many days after sending if still unsigned"),
  onboardingFolder: z.string().min(1).describe("Sub-folder of the vendor folder for signed onboarding documents"),
  fileName: templateString(["date", "vendor", "vendorId"], "Signed packet file name"),
  insurance: z
    .object({
      requiredTiers: z.array(z.enum(TIERS)).describe("Tiers that must hold a current certificate of insurance"),
      folder: z.string().min(1).describe("Sub-folder of the vendor folder holding certificates"),
      certificatePattern: z
        .string()
        .refine((p) => { try { return new RegExp(p).source.includes("(") ; } catch { return false; } }, "a regular expression with one capture group for the expiry date (YYYY-MM-DD)")
        .describe("File-name pattern of a certificate; group 1 is its expiry date"),
      noticeDays: z.array(z.number().int().min(1).max(365)).describe("Tell Procurement this many days before expiry"),
      renewalSubject: z.string().min(1),
      requestRenewalAtDays: z.number().int().min(1).max(365).describe("Draft the renewal request to the vendor this many days before expiry"),
    })
    .describe("Certificate of insurance tracking"),
  procurementChannel: z.string().regex(/^[CG][A-Z0-9]{6,}$/).describe("Slack channel for Procurement"),
});
export type Policy = z.infer<typeof Policy>;

const Input = z.object({
  vendorId: z.string().regex(/^[\w-]{2,40}$/, "vendor-master id"),
  vendor: z.object({ legalName: z.string().trim().min(1).max(160), contactName: z.string().trim().min(1).max(120), contactEmail: Email }),
  riskTier: z.enum(TIERS),
  processesPersonalData: z.boolean(),
  /** Skip the onboarding envelope (e.g. a run started only because a certificate changed). */
  insuranceOnly: z.boolean().default(false),
});
type Input = z.infer<typeof Input>;

export interface Envelopes {
  existing: { envelopeId: string; status: string } | null;
}
export interface Insurance {
  /** Latest certificate expiry date in the folder, or null when there is none. */
  expires: string | null;
  file: string | null;
}

export const externalId = (vendorId: string) => `vendor-${vendorId}`;
const live = (e: { status: string }) => !["voided", "declined"].includes(e.status);

/** Latest certificate expiry among file names. */
export function latestCertificate(names: string[], pattern: string): Insurance {
  const re = new RegExp(pattern);
  let best: Insurance = { expires: null, file: null };
  for (const n of names) {
    const d = re.exec(n)?.[1];
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && (!best.expires || d > best.expires)) best = { expires: d, file: n };
  }
  return best;
}

const folders = (p: Policy, input: Input) => {
  const base = fill(p.vendorFolder, { vendor: input.vendor.legalName, vendorId: input.vendorId });
  return { onboarding: `${base}/${p.onboardingFolder}`, insurance: `${base}/${p.insurance.folder}` };
};

export const vendorComplianceDocs: WorkflowDef<Input> = {
  id: "vendor-compliance-docs",
  title: "Vendor compliance documents",
  org: "Procurement",
  team: "supplier-onboarding",
  description:
    "Send a new supplier its onboarding packet by risk tier (W-9, terms or MSA, security addendum, DPA for personal data) through DocuSign and file it in Box or Dropbox on completion; track its certificate of insurance from the vendor's Insurance folder with notices before expiry, a drafted renewal request and a hold notice on expiry, standing down when a newer certificate is filed; tiers, templates, folders and notice days are policy.",
  input: Input,
  policy: { schema: Policy as z.ZodType<unknown>, defaults },
  audit: true,
  tickEvery: "rate(1 hour)",
  agents: [
    {
      name: "envelopes",
      needs: ["docusign"],
      async run({ input, providers, startedAt }) {
        if (input.insuranceOnly) return { summary: "insurance-only run", data: { existing: null } satisfies Envelopes };
        const from = new Date(startedAt.getTime() - 365 * DAY).toISOString();
        const found = (await providers.docusign!.findByExternalId(externalId(input.vendorId), from)).filter(live);
        const existing = found[0] ? { envelopeId: found[0].envelopeId, status: found[0].status } : null;
        return { summary: existing ? `envelope ${existing.envelopeId} already ${existing.status}` : "no onboarding envelope yet", data: { existing } satisfies Envelopes };
      },
    },
    {
      name: "insurance",
      needs: [],
      async run({ input, providers, policy }) {
        const p = policy as Policy;
        const docs = await storeOf(providers, p.store).list(folders(p, input).insurance);
        const cert = latestCertificate(docs.map((d) => d.name), p.insurance.certificatePattern);
        return { summary: cert.expires ? `certificate expires ${cert.expires} (${cert.file})` : `no certificate in ${p.store.provider}`, data: cert };
      },
    },
  ],

  plan({ input, policy, startedAt }, results) {
    const p = policy as Policy;
    const now = startedAt.getTime();
    const f = folders(p, input);
    const actions: PlannedAction<Input>[] = [];
    /** A Procurement notice; `text` may throw SkipAction when the notice no longer applies. */
    const slack = (id: string, summary: Record<string, unknown>, text: (ctx: ActionContext<Input>) => string | Promise<string>, extra: Partial<PlannedAction<Input>> = {}): PlannedAction<Input> => ({
      id,
      kind: id.split(":")[0]!,
      provider: "slack",
      agent: "insurance",
      gate: "auto",
      summary: { vendorId: input.vendorId, ...summary },
      async execute(ctx) {
        return { ref: (await ctx.providers.slack!.postMessage(p.procurementChannel, await text(ctx))).ts };
      },
      ...extra,
    });
    const name = input.vendor.legalName;

    // ---- Onboarding documents
    const env = out<Envelopes>(results, "envelopes");
    if (!input.insuranceOnly) {
      const packet = firstMatch(p.packets, { riskTier: input.riskTier });
      if (!env) {
        actions.push(slack("slack.post_blocked", {}, () => `:warning: Couldn't check DocuSign for ${name} (${input.vendorId}); onboarding documents were not sent.`, { agent: "envelopes" }));
      } else if (!packet) {
        actions.push(slack("slack.post_no_packet", { riskTier: input.riskTier }, () => `:grey_question: No onboarding packet for ${input.riskTier}-risk vendor ${name} (${input.vendorId}); nothing was sent.`, { agent: "envelopes" }));
      } else {
        const templates = [...packet.templates, ...(input.processesPersonalData && p.dpaTemplate ? [p.dpaTemplate] : [])];
        const send = "docusign.send_onboarding";
        const complete = "docusign.onboarding_completed";
        const existing = env.existing;
        actions.push(
          {
            id: send,
            kind: send,
            provider: "docusign",
            agent: "envelopes",
            gate: "auto",
            summary: { packet: packet.name, templates: templates.length, dpa: templates.length > packet.templates.length, to: input.vendor.contactEmail },
            async execute({ providers }) {
              const ds = providers.docusign!;
              if (existing) return { ref: existing.envelopeId, detail: { reused: true } };
              const again = (await ds.findByExternalId(externalId(input.vendorId), new Date(now - 365 * DAY).toISOString())).find(live);
              if (again) return { ref: again.envelopeId, detail: { reused: true } };
              const e = await ds.createFromTemplates({
                subject: fill(p.subject, { vendor: name }),
                templateIds: templates,
                roles: [{ roleName: p.signerRole, email: input.vendor.contactEmail, name: input.vendor.contactName }, ...(p.countersigner ? [p.countersigner] : [])],
                externalId: externalId(input.vendorId),
                reminders: { delayDays: p.docusign.reminderDelayDays, everyDays: p.docusign.reminderEveryDays },
                expireDays: p.docusign.expireDays,
              });
              return { ref: e.envelopeId, detail: { reused: false } };
            },
          },
          {
            id: complete,
            kind: complete,
            provider: p.store.provider,
            agent: "envelopes",
            gate: "auto",
            summary: { folder: f.onboarding, meaning: "approve = Connect reported completed, reject = declined or voided" },
            requires: [send],
            awaitSignal: { from: [p.connectSender], deadline: new Date(now + p.docusign.expireDays * DAY).toISOString(), onDeadline: "reject" },
            async execute({ providers, applied }) {
              const id = applied[send]!.ref;
              const e = await providers.docusign!.getEnvelope(id);
              // The Connect signal is a prompt, not proof.
              if (e.status !== "completed") throw new Error(`Connect reported completion but DocuSign says ${e.status}`);
              const file = fill(p.fileName, { date: (e.completedDateTime ?? new Date().toISOString()).slice(0, 10), vendor: name, vendorId: input.vendorId });
              const store = storeOf(providers, p.store);
              const found = await store.find(f.onboarding, file);
              if (found) return { ref: found.id, detail: { path: `${f.onboarding}/${file}`, existed: true } };
              const doc = await store.put(f.onboarding, file, Buffer.from(await providers.docusign!.combinedPdfBase64(id, true), "base64"));
              return { ref: doc.id, detail: { path: `${f.onboarding}/${file}`, existed: doc.existed } };
            },
          },
        );
        for (const d of [...new Set(p.unsignedEscalateDays)].sort((a, b) => a - b)) {
          actions.push(
            slack(
              `procurement.unsigned:${d}`,
              { days: d },
              ({ statuses }) => {
                if (statuses[complete] !== "awaiting_signal") throw new SkipAction(`documents ${statuses[complete]}`);
                return `:hourglass: ${name} (${input.vendorId}) hasn't signed its onboarding documents after ${d} day(s). Contact: ${input.vendor.contactName} <${input.vendor.contactEmail}>.`;
              },
              { agent: "envelopes", delayAfter: { action: send, ms: d * DAY } },
            ),
          );
        }
        actions.push(
          slack(
            "procurement.onboarding_declined",
            {},
            ({ statuses }) => {
              if (statuses[complete] !== "rejected" && statuses[complete] !== "failed") throw new SkipAction(`documents ${statuses[complete]}`);
              return `:no_entry: ${name}'s onboarding documents (${input.vendorId}) were declined, voided, expired or couldn't be filed. Don't activate the vendor until they are signed.`;
            },
            { agent: "envelopes", after: [complete] },
          ),
        );
      }
    }

    // ---- Certificate of insurance
    const cert = out<Insurance>(results, "insurance");
    const required = p.insurance.requiredTiers.includes(input.riskTier);
    if (!cert) {
      actions.push(slack("slack.post_insurance_unreadable", {}, () => `:warning: ${name} (${input.vendorId}): the Insurance folder in ${p.store.provider} couldn't be read, so certificate expiry isn't being tracked.`));
      return actions;
    }
    if (!cert.expires || Date.parse(onDate(cert.expires)) <= now) {
      if (required)
        actions.push(
          slack("procurement.coi_missing", { expired: cert.expires }, () =>
            cert.expires
              ? `:no_entry: ${name} (${input.vendorId}): its certificate of insurance expired ${cert.expires}. Hold new orders until a current certificate is filed in ${f.insurance}.`
              : `:no_entry: ${name} (${input.vendorId}) is ${input.riskTier}-risk and has no certificate of insurance in ${f.insurance}. Don't activate the vendor until one is filed as "COI <expiry date>.pdf".`,
          ),
        );
      return actions;
    }
    const expires = cert.expires;
    /** Stands a timer down when a newer certificate has been filed since this run read the folder. */
    const current = async (providers: Providers) => {
      const latest = latestCertificate((await storeOf(providers, p.store).list(f.insurance)).map((d) => d.name), p.insurance.certificatePattern);
      if (latest.expires && latest.expires > expires) throw new SkipAction(`renewed: certificate now expires ${latest.expires}`);
    };
    for (const d of [...new Set(p.insurance.noticeDays)].sort((a, b) => b - a)) {
      const when = onDate(expires, -d);
      if (Date.parse(when) <= now) continue;
      actions.push(
        slack(
          `procurement.coi_notice:${d}`,
          { expires, daysBefore: d },
          async ({ providers }) => {
            await current(providers);
            return `:shield: ${name} (${input.vendorId}): certificate of insurance expires ${expires} (${d} days).`;
          },
          { waitUntil: when },
        ),
      );
    }
    const ask = onDate(expires, -p.insurance.requestRenewalAtDays);
    actions.push({
      id: "gmail.coi_renewal_request",
      kind: "gmail.coi_renewal_request",
      provider: "gmail",
      agent: "insurance",
      gate: "auto",
      summary: { vendorId: input.vendorId, to: input.vendor.contactEmail, expires, sent: false },
      ...(Date.parse(ask) > now ? { waitUntil: ask } : {}),
      async execute({ providers, runId }) {
        await current(providers);
        const d = await providers.gmail!.createDraft({
          to: input.vendor.contactEmail,
          subject: p.insurance.renewalSubject,
          body: `Hello ${input.vendor.contactName.split(/\s+/)[0]},\n\nOur records show ${name}'s certificate of insurance expires on ${expires}. Please send an updated certificate naming Acme as certificate holder before then, so orders can continue without interruption.\n\nThank you,\nAcme Procurement`,
          messageId: messageId(runId, `coi-${input.vendorId}-${expires}`),
        });
        return { ref: d.id };
      },
    });
    actions.push(
      slack(
        "procurement.coi_expired",
        { expires },
        async ({ providers }) => {
          await current(providers);
          return `:no_entry: ${name} (${input.vendorId}): certificate of insurance expired today (${expires}) and no newer certificate is filed${required ? ". Hold new orders until one is." : "."}`;
        },
        { waitUntil: onDate(expires, 0) },
      ),
    );
    return actions;
  },

  output({ input, policy }, results) {
    const p = policy as Policy;
    const env = out<Envelopes>(results, "envelopes");
    const cert = out<Insurance>(results, "insurance");
    const packet = firstMatch(p.packets, { riskTier: input.riskTier });
    return {
      onboarding: input.insuranceOnly ? "not_requested" : !env ? "blocked" : !packet ? "no_packet" : env.existing ? "existing_envelope" : "sent",
      insurance: !cert ? "unreadable" : !cert.expires ? "missing" : cert.expires < new Date().toISOString().slice(0, 10) ? "expired" : "tracked",
      insuranceRequired: p.insurance.requiredTiers.includes(input.riskTier),
      ...(cert?.expires ? { certificateExpires: cert.expires } : {}),
    };
  },

  catalog: [
    { kind: "docusign.send_onboarding", provider: "docusign", gate: "auto", description: "Send the tier's onboarding packet (+ DPA for personal data) with DocuSign reminders and expiry; reuses an envelope already sent" },
    { kind: "docusign.onboarding_completed", provider: "box", gate: "auto", description: "Signal: Connect reports completion (approve) or decline/void (reject); re-checked with DocuSign, then filed in Box or Dropbox" },
    { kind: "procurement.unsigned", provider: "slack", gate: "auto", description: "Still unsigned 7 and 14 days after sending" },
    { kind: "procurement.onboarding_declined", provider: "slack", gate: "auto", description: "Declined, voided, expired or not filed: don't activate the vendor" },
    { kind: "procurement.coi_missing", provider: "slack", gate: "auto", description: "Tier requires insurance and the certificate is missing or expired" },
    { kind: "procurement.coi_notice", provider: "slack", gate: "auto", description: "Certificate expires in 60, 30 and 7 days (stands down when renewed)" },
    { kind: "gmail.coi_renewal_request", provider: "gmail", gate: "auto", description: "Renewal request to the vendor contact (draft) 30 days before expiry" },
    { kind: "procurement.coi_expired", provider: "slack", gate: "auto", description: "Expired with no newer certificate: hold the vendor" },
    { kind: "slack.post_no_packet", provider: "slack", gate: "auto", description: "No packet for the tier: nothing sent" },
    { kind: "slack.post_blocked", provider: "slack", gate: "auto", description: "DocuSign unreadable: nothing sent" },
    { kind: "slack.post_insurance_unreadable", provider: "slack", gate: "auto", description: "Insurance folder unreadable: expiry not tracked" },
  ],
};
