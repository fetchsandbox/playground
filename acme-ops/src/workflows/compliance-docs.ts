import { z } from "zod";
import { FatalError } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import type { BoxFile } from "../providers/work";
import { Approvers, ChannelId, Email, messageId, out, plain, shortHash } from "./shared";

// Quality · quality-compliance.
// Trigger: a customer asks for compliance documents for a part (RoHS / REACH
// declarations, certificate of conformance, calibration certificate).

export const DOC_TYPES = ["rohs", "reach", "coc", "calibration", "conflict_minerals"] as const;
type DocType = (typeof DOC_TYPES)[number];
const LABEL: Record<DocType, string> = { rohs: "RoHS declaration", reach: "REACH declaration", coc: "Certificate of conformance", calibration: "Calibration certificate", conflict_minerals: "Conflict minerals report" };
/** Words a file name must contain to count as that document. */
const KEYWORDS: Record<DocType, string[]> = { rohs: ["rohs"], reach: ["reach"], coc: ["coc", "conformance"], calibration: ["calibration", "cal-cert"], conflict_minerals: ["cmrt", "conflict"] };

const Input = z.object({
  requester: z.object({ email: Email, name: z.string().max(200).optional() }),
  product: z.string().min(1).max(200),
  docTypes: z.array(z.enum(DOC_TYPES)).min(1).max(5),
  qualityChannel: ChannelId,
  qualityWorkspace: z.string().min(1).default("acme-quality"),
  /** Box folder holding ACME's released compliance documents. */
  libraryFolderId: z.string().min(1).default("0"),
  linkExpiryDays: z.number().int().min(1).max(30).default(14),
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

interface Product {
  id: string;
  name: string;
}
interface Library {
  found: Partial<Record<DocType, { fileId: string; name: string }>>;
  missing: DocType[];
}
interface Reply {
  subject: string;
  body: string;
  draftedBy: string;
}

/** Pick the file for a doc type: the name must mention the doc type and the part. */
export function matchDoc(files: BoxFile[], type: DocType, product: Product): BoxFile | undefined {
  const part = [product.id.toLowerCase(), product.name.toLowerCase()];
  return files
    .filter((f) => f?.type === "file" && typeof f.name === "string")
    .filter((f) => KEYWORDS[type].some((k) => f.name.toLowerCase().includes(k)) && part.some((p) => f.name.toLowerCase().includes(p)))
    .sort((a, b) => b.name.localeCompare(a.name))[0];
}

export const complianceDocs: WorkflowDef<Input> = {
  id: "compliance-docs",
  title: "Compliance documents on request",
  org: "Quality",
  team: "quality-compliance",
  description:
    "Answer a customer's request for compliance documents: validate the part, look the documents up in the Box library and draft the reply. Sharing a document externally waits for approval; anything missing goes to Quality as an Asana task with a holding reply.",
  input: Input,
  agents: [
    {
      name: "part-check",
      needs: ["stripe"],
      async run({ input, providers }) {
        const key = input.product.trim().toLowerCase();
        const p = (await providers.stripe!.listProducts()).find((x) => x.id.toLowerCase() === key || x.name.toLowerCase() === key);
        if (!p) throw new FatalError(`unknown part ${input.product}`);
        return { summary: `${p.name} (${p.id})`, data: { id: p.id, name: p.name } satisfies Product };
      },
    },
    {
      name: "requester-context",
      needs: ["hubspot"],
      async run({ input, providers }) {
        const c = await providers.hubspot!.findByEmail(input.requester.email);
        return { summary: c ? `HubSpot contact ${c.id}` : "unknown requester", data: { known: !!c, company: c?.properties.company ?? null } };
      },
    },
    {
      name: "document-library",
      needs: ["stripe", "box"],
      async run({ input, providers }) {
        const key = input.product.trim().toLowerCase();
        const p = (await providers.stripe!.listProducts()).find((x) => x.id.toLowerCase() === key || x.name.toLowerCase() === key);
        const product: Product = p ? { id: p.id, name: p.name } : { id: input.product, name: input.product };
        const found: Library["found"] = {};
        for (const t of input.docTypes) {
          const files = await providers.box!.search(`${product.name} ${KEYWORDS[t][0]}`, input.libraryFolderId === "0" ? undefined : input.libraryFolderId);
          const f = matchDoc(files, t, product);
          if (f) found[t] = { fileId: f.id, name: f.name };
        }
        const data: Library = { found, missing: input.docTypes.filter((t) => !found[t]) };
        return { summary: `${Object.keys(found).length} found, ${data.missing.length} missing`, data };
      },
    },
  ],

  compose: {
    name: "reply-composer",
    async run({ input, drafter }, results) {
      const product = out<Product>(results, "part-check");
      const lib = out<Library>(results, "document-library");
      const first = input.requester.name?.split(" ")[0] ?? "there";
      const part = product?.name ?? input.product;
      // Without the library we can't say what exists; everything goes to Quality.
      const missing = lib ? lib.missing : [...input.docTypes];
      const holding = await drafter.draft({
        task: "compliance-holding",
        instructions: "Draft a short holding reply: the quality team is preparing the listed documents and will send them. Do not promise a date.",
        facts: { firstName: first, part, documents: missing.map((t) => LABEL[t]) },
        fallback: {
          subject: `Re: compliance documents for ${plain(part, 80)}`,
          body: `Hi ${first},\n\nThanks for your request. Our quality team is preparing the following for ${plain(part, 80)}:\n${missing.map((t) => `- ${LABEL[t]}`).join("\n")}\n\nWe'll send them as soon as they're ready.\n\nACME Quality`,
        },
      });
      return { summary: `${missing.length} document(s) to prepare`, data: { holding, missing } };
    },
  },

  plan({ input, startedAt }, results) {
    const product = out<Product>(results, "part-check");
    const lib = out<Library>(results, "document-library");
    const composed = out<{ holding: Reply; missing: DocType[] }>(results, "reply-composer");
    if (!composed) return [];
    const actions: PlannedAction<Input>[] = [];
    const part = product?.name ?? input.product;

    actions.push({
      id: "slack.post_request",
      kind: "slack.post_request",
      provider: "slack",
      agent: "reply-composer",
      gate: "auto",
      summary: { channel: input.qualityChannel, product: part, requested: input.docTypes },
      async execute({ providers }) {
        const text = product
          ? `:page_facing_up: ${input.requester.email} asked for ${input.docTypes.map((t) => LABEL[t]).join(", ")} on ${plain(part, 80)}. ${composed.missing.length ? `To prepare: ${composed.missing.map((t) => LABEL[t]).join(", ")}.` : "All found; sharing awaits approval."}`
          : `:warning: ${input.requester.email} asked for compliance documents on unknown part "${plain(input.product, 80)}"; needs review.`;
        const m = await providers.slack!.postMessage(input.qualityChannel, text);
        return { ref: m.ts, detail: { channel: m.channel } };
      },
    });
    // An unknown part gets no customer-facing reply: Quality decides what it is.
    if (!product) return actions;

    if (composed.missing.length) {
      actions.push({
        id: "asana.request_documents",
        kind: "asana.request_documents",
        provider: "asana",
        agent: "reply-composer",
        gate: "auto",
        summary: { product: part, documents: composed.missing, libraryReachable: !!lib },
        async execute({ providers }) {
          const t = await providers.asana!.createTask({
            name: `Compliance docs for ${plain(part, 80)} → ${input.requester.email}`,
            notes: `Prepare and release: ${composed.missing.map((t) => LABEL[t]).join(", ")}.${lib ? "" : "\nThe Box library could not be searched; check whether these already exist."}`,
            workspace: input.qualityWorkspace,
          });
          return { ref: t.gid };
        },
        async reconcile({ providers }, receipt) {
          const t = await providers.asana!.getTask(receipt.ref);
          return t.completed ? { status: "drift", detail: "closed before the documents were sent" } : { status: "match" };
        },
      });
      actions.push({
        id: "gmail.draft_holding_reply",
        kind: "gmail.draft_holding_reply",
        provider: "gmail",
        agent: "reply-composer",
        gate: "auto",
        summary: { to: input.requester.email, documents: composed.missing, draftedBy: composed.holding.draftedBy, sent: false },
        async execute({ providers, runId }) {
          const d = await providers.gmail!.createDraft({ to: input.requester.email, subject: composed.holding.subject, body: composed.holding.body, messageId: messageId(runId, "holding") });
          return { ref: d.id };
        },
      });
    }

    const found = Object.entries(lib?.found ?? {}) as [DocType, { fileId: string; name: string }][];
    if (found.length) {
      const expires = new Date(startedAt.getTime() + input.linkExpiryDays * 86_400_000).toISOString();
      for (const [t, f] of found) {
        actions.push({
          id: `box.share_${t}:${shortHash(f.fileId)}`,
          kind: "box.share_document",
          provider: "box",
          agent: "document-library",
          gate: "approval",
          summary: { document: LABEL[t], file: f.name, expires, access: "open link, download only" },
          async execute({ providers }) {
            const l = await providers.box!.createSharedLink(f.fileId, expires);
            return { ref: f.fileId, detail: { url: l.url, type: t } };
          },
        });
      }
      actions.push({
        id: "gmail.draft_documents",
        kind: "gmail.draft_documents",
        provider: "gmail",
        agent: "reply-composer",
        gate: "approval",
        summary: { to: input.requester.email, documents: found.map(([t]) => t), sent: false },
        async execute({ providers, applied, runId }) {
          const links = found.map(([t, f]) => `- ${LABEL[t]}: ${applied[`box.share_${t}:${shortHash(f.fileId)}`]?.detail?.url ?? "(link not created)"}`);
          const first = input.requester.name?.split(" ")[0] ?? "there";
          const d = await providers.gmail!.createDraft({
            to: input.requester.email,
            subject: `Compliance documents for ${plain(part, 80)}`,
            body: `Hi ${first},\n\nHere are the documents you asked for:\n${links.join("\n")}\n\nThe links expire on ${expires.slice(0, 10)}.\n\nACME Quality`,
            messageId: messageId(runId, "documents"),
          });
          return { ref: d.id };
        },
      });
    }
    return actions;
  },

  output({ input }, results) {
    const product = out<Product>(results, "part-check");
    const lib = out<Library>(results, "document-library");
    return {
      product: product?.id ?? null,
      partValid: !!product,
      requested: input.docTypes,
      found: Object.keys(lib?.found ?? {}),
      missing: lib ? lib.missing : input.docTypes,
      librarySearched: !!lib,
    };
  },

  catalog: [
    { kind: "slack.post_request", provider: "slack", gate: "auto", description: "Post the request to the Quality channel" },
    { kind: "asana.request_documents", provider: "asana", gate: "auto", description: "Ask Quality to prepare missing documents" },
    { kind: "gmail.draft_holding_reply", provider: "gmail", gate: "auto", description: "Create (not send) a holding reply while documents are prepared" },
    { kind: "box.share_document", provider: "box", gate: "approval", description: "Create an expiring external Box link to a released document" },
    { kind: "gmail.draft_documents", provider: "gmail", gate: "approval", description: "Create (not send) the reply carrying the document links" },
  ],
};
