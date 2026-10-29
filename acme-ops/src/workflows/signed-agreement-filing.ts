import { z } from "zod";
import { SkipAction } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import type { DocuSignEnvelope } from "../providers/work";
import defaults from "../../policies/signed-agreement-filing.json";
import { ChannelPolicy, fill, storeOf, StorePolicy, templateString } from "./lib/documents";
import { out } from "./shared";

// Legal · contract-ops.
// Trigger: DocuSign Connect reports an envelope completed (or the daily sweep
// of completed envelopes calls `start` once per envelope).
// The signed PDF (with DocuSign's certificate of completion) is filed in the
// company's document store, Box or Dropbox, in the folder its agreement type
// calls for, and the owning team is told where it is. Everything a company
// would change is policy (policies/signed-agreement-filing.json): the store,
// how a type is recognized, folder and file naming, who is told, and which
// types need an Acme countersignature. Rules:
//   - only a completed envelope is filed; other events are ignored;
//   - the type comes from the envelope's custom field, then a form field, then
//     the subject; a type the policy doesn't know is never guessed: the PDF
//     goes to the review folder and Legal is told;
//   - a type that needs a countersignature and has no internal signer is filed
//     for review, not as executed;
//   - filing is idempotent by envelope id and never overwrites a document;
//   - an envelope that can't be read files nothing and Legal is told.

const FOLDER_VARS = ["type", "counterparty", "year", "month"] as const;
const FILE_VARS = ["date", "type", "counterparty", "envelopeId", "subject"] as const;

const Destination = z.object({
  folder: templateString(FOLDER_VARS, "Folder path below the store root"),
  notify: ChannelPolicy.describe("Slack channel told when a document is filed (null: nobody)"),
  requireInternalSigner: z.boolean().describe("File for review unless someone from an internal domain signed"),
});

export const Policy = z.object({
  store: StorePolicy,
  internalDomains: z.array(z.string().min(3)).min(1).describe("Email domains of your own signers (countersignature check, counterparty detection)"),
  legalChannel: z.string().regex(/^[CG][A-Z0-9]{6,}$/).describe("Slack channel for failures (envelope unreadable, store unavailable)"),
  classification: z
    .object({
      customField: z.string().min(1).describe("Envelope custom field holding the agreement type (set by your templates or sender)"),
      formField: z.string().min(1).describe("Form field (tab label) holding the agreement type"),
      subjectRules: z
        .array(z.object({ pattern: z.string().refine((p) => { try { new RegExp(p, "i"); return true; } catch { return false; } }, "invalid regular expression"), type: z.string().min(1) }))
        .describe("Case-insensitive patterns on the envelope subject, first match wins"),
    })
    .describe("How an envelope's agreement type is recognized"),
  counterparty: z.object({ customField: z.string().min(1), formField: z.string().min(1) }).describe("Where the counterparty name is read; otherwise the first external signer's email domain"),
  types: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), Destination).describe("Agreement types this company files, and where"),
  review: z.object({ folder: templateString(FOLDER_VARS, "Review folder"), notify: z.string().regex(/^[CG][A-Z0-9]{6,}$/) }).describe("Unrecognized types and missing countersignatures go here, and this channel is told"),
  fileName: templateString(FILE_VARS, "File name"),
  includeCertificate: z.boolean().describe("Append DocuSign's certificate of completion to the filed PDF"),
}).superRefine((p, ctx) => {
  for (const r of p.classification.subjectRules) if (!p.types[r.type]) ctx.addIssue({ code: "custom", path: ["classification", "subjectRules"], message: `subject rule maps to ${r.type}, which isn't in types` });
});
export type Policy = z.infer<typeof Policy>;

const Input = z.object({
  envelopeId: z.string().regex(/^[0-9a-fA-F-]{36}$/, "DocuSign envelope id (GUID)"),
  /** The Connect event that triggered the run, e.g. envelope-completed. */
  event: z.string().regex(/^[a-z-]{3,40}$/).default("envelope-completed"),
});
type Input = z.infer<typeof Input>;

export interface Envelope {
  envelopeId: string;
  status: string;
  subject: string;
  completedAt: string | null;
  signers: { email: string; name: string; status: string }[];
  fields: Record<string, string>;
}

export interface Filing {
  type: string | null;
  /** How the type was recognized. */
  source: "custom_field" | "form_field" | "subject" | null;
  counterparty: string;
  review: string | null;
  folder: string;
  name: string;
  notify: string | null;
}

const domainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

/** Pure: where and how the policy says this envelope is filed. */
export function classify(env: Envelope, p: Policy): Filing {
  const internal = (e: string) => p.internalDomains.some((d) => domainOf(e) === d.toLowerCase());
  const known = (v: string | undefined) => (v && p.types[v.toUpperCase()] ? v.toUpperCase() : undefined);
  const custom = env.fields[`custom:${p.classification.customField}`];
  const form = env.fields[`form:${p.classification.formField}`];
  const subject = p.classification.subjectRules.find((r) => new RegExp(r.pattern, "i").test(env.subject))?.type;
  const [type, source] = known(custom) ? [known(custom)!, "custom_field" as const] : known(form) ? [known(form)!, "form_field" as const] : subject ? [subject, "subject" as const] : [null, null];
  const external = env.signers.find((s) => !internal(s.email));
  const counterparty = env.fields[`custom:${p.counterparty.customField}`] || env.fields[`form:${p.counterparty.formField}`] || (external ? domainOf(external.email) : "") || "unknown";
  const at = env.completedAt ?? new Date(0).toISOString();
  const vars = { type: type ?? "UNCLASSIFIED", counterparty, year: at.slice(0, 4), month: at.slice(5, 7), date: at.slice(0, 10), envelopeId: env.envelopeId, subject: env.subject };
  const dest = type ? p.types[type]! : undefined;
  let review: string | null = null;
  if (!type) review = custom || form ? `agreement type "${custom || form}" isn't in the policy` : "agreement type not recognized";
  else if (dest!.requireInternalSigner && !env.signers.some((s) => internal(s.email) && s.status === "completed")) review = `${type} has no countersignature from ${p.internalDomains.join(", ")}`;
  return {
    type,
    source,
    counterparty,
    review,
    folder: fill(review ? p.review.folder : dest!.folder, vars),
    name: fill(p.fileName, vars),
    notify: review ? p.review.notify : dest!.notify,
  };
}

export function toEnvelope(d: DocuSignEnvelope, form: Record<string, string>): Envelope {
  const fields: Record<string, string> = {};
  for (const f of [...(d.customFields?.textCustomFields ?? []), ...(d.customFields?.listCustomFields ?? [])]) if (f.value) fields[`custom:${f.name}`] = f.value;
  for (const [k, v] of Object.entries(form)) if (v) fields[`form:${k}`] = v;
  return { envelopeId: d.envelopeId, status: d.status, subject: d.emailSubject ?? "", completedAt: d.completedDateTime ?? null, signers: (d.recipients?.signers ?? []).map((s) => ({ email: s.email, name: s.name, status: s.status })), fields };
}

export const signedAgreementFiling: WorkflowDef<Input> = {
  id: "signed-agreement-filing",
  title: "Signed agreement filing",
  org: "Legal",
  team: "contract-ops",
  description:
    "When a DocuSign envelope completes, file the signed PDF (with its certificate of completion) in Box or Dropbox in the folder its agreement type calls for and tell the owning team; unrecognized types and missing countersignatures go to a review folder for Legal; idempotent by envelope id, never overwrites; folders, naming, types and channels are policy.",
  input: Input,
  policy: { schema: Policy as z.ZodType<unknown>, defaults },
  audit: true,
  agents: [
    {
      name: "envelope",
      needs: ["docusign"],
      async run({ input, providers }) {
        const ds = providers.docusign!;
        const d = await ds.getEnvelopeDetail(input.envelopeId);
        const env = toEnvelope(d, d.status === "completed" ? await ds.formData(input.envelopeId) : {});
        return { summary: `${env.status}: ${env.subject || "(no subject)"}, ${env.signers.length} signer(s)`, data: env };
      },
    },
  ],

  plan({ input, policy }, results) {
    const p = policy as Policy;
    const env = out<Envelope>(results, "envelope");
    if (!env) {
      return [
        {
          id: "slack.post_unreadable",
          kind: "slack.post_unreadable",
          provider: "slack",
          agent: "envelope",
          gate: "auto",
          summary: { envelopeId: input.envelopeId },
          async execute({ providers }) {
            return { ref: (await providers.slack!.postMessage(p.legalChannel, `:warning: DocuSign envelope ${input.envelopeId} (${input.event}) could not be read. Nothing was filed; file it by hand or re-run.`)).ts };
          },
        },
      ];
    }
    if (env.status !== "completed") return [];
    const f = classify(env, p);
    const fileId = "storage.file_signed";
    const actions: PlannedAction<Input>[] = [
      {
        id: fileId,
        kind: "storage.file_signed",
        provider: p.store.provider,
        agent: "envelope",
        gate: "auto",
        summary: { store: p.store.provider, folder: f.folder, name: f.name, type: f.type, review: f.review },
        async execute({ providers }) {
          const store = storeOf(providers, p.store);
          // Bytes go straight from DocuSign to the store; the run keeps only where they went.
          const existing = await store.find(f.folder, f.name);
          if (existing) return { ref: existing.id, detail: { path: `${f.folder}/${f.name}`, existed: true } };
          const pdf = Buffer.from(await providers.docusign!.combinedPdfBase64(env.envelopeId, p.includeCertificate), "base64");
          const doc = await store.put(f.folder, f.name, pdf);
          return { ref: doc.id, detail: { path: `${f.folder}/${f.name}`, existed: doc.existed, bytes: pdf.length } };
        },
        async reconcile({ providers }) {
          const doc = await storeOf(providers, p.store).find(f.folder, f.name);
          return doc ? { status: "match" } : { status: "missing", detail: `${f.folder}/${f.name} is no longer in ${p.store.provider}` };
        },
      },
    ];
    if (f.notify) {
      const channel = f.notify;
      actions.push({
        id: "slack.notify_filed",
        kind: "slack.notify_filed",
        provider: "slack",
        agent: "envelope",
        gate: "auto",
        summary: { channel, type: f.type, review: f.review },
        requires: [fileId],
        async execute({ providers, applied }) {
          const where = `${p.store.provider}: ${f.folder}/${f.name}`;
          const text = f.review
            ? `:inbox_tray: Signed envelope "${env.subject}" (${env.envelopeId}) needs filing review: ${f.review}. It is in ${where}.`
            : `:white_check_mark: ${f.type} with ${f.counterparty} is signed and filed in ${where}${applied[fileId]?.detail?.existed ? " (already there)" : ""}.`;
          return { ref: (await providers.slack!.postMessage(channel, text)).ts };
        },
      });
    }
    // The store couldn't take it: Legal hears about it once, so the signed copy isn't lost silently.
    actions.push({
      id: "slack.post_filing_failed",
      kind: "slack.post_filing_failed",
      provider: "slack",
      agent: "envelope",
      gate: "auto",
      summary: { envelopeId: env.envelopeId },
      after: [fileId],
      async execute({ providers, statuses }) {
        if (statuses[fileId] !== "failed") throw new SkipAction(`filing is ${statuses[fileId]}`);
        return { ref: (await providers.slack!.postMessage(p.legalChannel, `:warning: Signed envelope ${env.envelopeId} ("${env.subject}") could not be filed in ${p.store.provider} (${f.folder}). It is still in DocuSign; resume the run or file it by hand.`)).ts };
      },
    });
    return actions;
  },

  output({ policy }, results) {
    const env = out<Envelope>(results, "envelope");
    if (!env) return { mode: "blocked" };
    if (env.status !== "completed") return { mode: "ignored", status: env.status };
    const f = classify(env, policy as Policy);
    return { mode: f.review ? "review" : "filed", type: f.type ?? "UNCLASSIFIED", typeSource: f.source ?? "none", counterparty: f.counterparty, folder: f.folder };
  },

  catalog: [
    { kind: "storage.file_signed", provider: "box", gate: "auto", description: "File the signed PDF and certificate in the policy's store (Box or Dropbox) and folder; never overwrites" },
    { kind: "slack.notify_filed", provider: "slack", gate: "auto", description: "Tell the type's channel where it is filed, or Legal why it needs review" },
    { kind: "slack.post_filing_failed", provider: "slack", gate: "auto", description: "The store refused the document: Legal is told it is still only in DocuSign" },
    { kind: "slack.post_unreadable", provider: "slack", gate: "auto", description: "Envelope unreadable: nothing filed, Legal told" },
  ],
};
