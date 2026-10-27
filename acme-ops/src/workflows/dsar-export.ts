import { createHash } from "node:crypto";
import { z } from "zod";
import { FatalError, SkipAction } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import type { Providers } from "../providers";
import { ChannelId, Email, messageId, out, shortHash } from "./shared";

// Legal · privacy-ops.
// Trigger: a data subject access request (GDPR Art. 15 / CCPA right to know).
// Discovery runs in parallel and keeps only references (ids and counts): the
// personal data itself is read again when the export is assembled, so the run
// record never holds it. Then, durably:
//   - a privacy team member confirms the requester's identity (signal);
//   - the export is assembled from HubSpot, Stripe and Zendesk and uploaded to Box;
//   - a privacy analyst who did not verify the identity reviews it (signal);
//   - an expiring Box link goes into a Gmail draft to the requester (never sent
//     by the workflow);
//   - reminders before the statutory deadline and an escalation just before it,
//     both skipped once the response is drafted.
// An incomplete discovery exports nothing: a partial answer to a DSAR is a breach.

export const DEADLINE_DAYS = { gdpr: 30, ccpa: 45 } as const;
export const POLICY = { remindDaysBefore: 10, escalateDaysBefore: 3, verifyWithinDays: 10, linkDays: 7, maxTickets: 200 } as const;
const DAY = 86_400_000;

const Input = z.object({
  requestId: z.string().regex(/^DSAR-[\w-]{3,40}$/, "request id like DSAR-2026-0042"),
  subject: z.object({ email: Email, name: z.string().max(200).optional() }),
  regulation: z.enum(["gdpr", "ccpa"]),
  receivedAt: z.iso.datetime(),
  privacyChannel: ChannelId,
  /** Box folder that holds exports (restricted to privacy-ops). */
  exportFolderId: z.string().regex(/^\d+$/),
  /** May confirm the requester's identity. */
  verifiers: z.array(z.string().min(1)).min(1).max(20),
  /** May release the export; never the same person who verified the identity. */
  analysts: z.array(z.string().min(1)).min(1).max(20),
  dsarWorkspace: z.string().min(1).default("acme-privacy"),
});
type Input = z.infer<typeof Input>;

export interface Inventory {
  crm: { contactIds: string[] } | null;
  billing: { customerIds: string[]; invoiceIds: string[] } | null;
  support: { ticketIds: number[]; truncated: boolean } | null;
}

/** Discovery is complete only when every system was searched and none was cut short. */
export function completeness(inv: Inventory): { complete: boolean; missing: string[] } {
  const missing = [
    ...(inv.crm ? [] : ["CRM (HubSpot)"]),
    ...(inv.billing ? [] : ["billing (Stripe)"]),
    ...(inv.support ? (inv.support.truncated ? [`support (more than ${POLICY.maxTickets} tickets)`] : []) : ["support (Zendesk)"]),
  ];
  return { complete: missing.length === 0, missing };
}

export const deadlineOf = (input: Pick<Input, "receivedAt" | "regulation">) => new Date(Date.parse(input.receivedAt) + DEADLINE_DAYS[input.regulation] * DAY).toISOString();
export const exportName = (requestId: string) => `${requestId}-export.json`;

/** Reads every referenced record and returns the export document (the only place personal data is assembled). */
export async function assemble(providers: Providers, input: Input, inv: Inventory) {
  const hubspot = await Promise.all(inv.crm!.contactIds.map((id) => providers.hubspot!.get(id)));
  const stripe = providers.stripe!;
  const customers = await Promise.all(inv.billing!.customerIds.map((id) => stripe.getCustomer(id)));
  const invoices = await Promise.all(inv.billing!.invoiceIds.map((id) => stripe.getInvoice(id)));
  const zd = providers.zendesk!;
  const tickets = await Promise.all(
    inv.support!.ticketIds.map(async (id) => {
      const [t, comments] = await Promise.all([zd.getTicket(id), zd.listComments(id)]);
      // Internal notes are about the requester, but staff deliberations are withheld; only public replies are disclosed.
      return { id: t.id, subject: t.subject, status: t.status, created_at: t.created_at, comments: comments.filter((c) => c.public !== false).map((c) => ({ at: c.created_at, body: c.body })) };
    }),
  );
  const doc = {
    request: { id: input.requestId, regulation: input.regulation, receivedAt: input.receivedAt, subject: input.subject.email },
    systems: {
      crm: hubspot.map((c) => ({ id: c.id, properties: Object.fromEntries(Object.entries(c.properties).filter(([, v]) => v != null && v !== "")) })),
      billing: { customers: customers.map((c) => ({ id: c.id, email: c.email, name: c.name, address: c.address ?? null, created: c.created ?? null })), invoices: invoices.map((i) => ({ id: i.id, number: i.number ?? null, status: i.status, amount_due: i.amount_due, currency: i.currency, created: i.created ?? null })) },
      support: tickets,
    },
  };
  const body = JSON.stringify(doc, null, 2);
  return { body, sha256: createHash("sha256").update(body).digest("hex"), counts: { crm: hubspot.length, customers: customers.length, invoices: invoices.length, tickets: tickets.length } };
}

export const dsarExport: WorkflowDef<Input> = {
  id: "dsar-export",
  title: "Data subject access request export (GDPR / CCPA)",
  org: "Legal",
  team: "privacy-ops",
  description:
    "Find a data subject's records in HubSpot, Stripe and Zendesk, wait for a privacy team member to confirm their identity, assemble the export and upload it to Box, wait for a different analyst to review it, then draft the response with an expiring link; remind before the statutory deadline and escalate just before it. Incomplete discovery exports nothing.",
  input: Input,
  audit: true,
  tickEvery: "rate(1 hour)",
  agents: [
    {
      name: "crm",
      needs: ["hubspot"],
      async run({ input, providers }) {
        const c = await providers.hubspot!.findByEmail(input.subject.email);
        return { summary: c ? "1 HubSpot contact" : "no HubSpot contact", data: { contactIds: c ? [c.id] : [] } satisfies Inventory["crm"] };
      },
    },
    {
      name: "billing",
      needs: ["stripe"],
      async run({ input, providers }) {
        const stripe = providers.stripe!;
        const customers = (await stripe.findCustomersByEmail(input.subject.email)).filter((c) => c.email?.toLowerCase() === input.subject.email);
        const invoiceIds: string[] = [];
        for (const c of customers) invoiceIds.push(...(await stripe.listInvoices(c.id)).filter((i) => i.customer === c.id).map((i) => i.id));
        return { summary: `${customers.length} customer(s), ${invoiceIds.length} invoice(s)`, data: { customerIds: customers.map((c) => c.id), invoiceIds } satisfies Inventory["billing"] };
      },
    },
    {
      name: "support",
      needs: ["zendesk"],
      async run({ input, providers }) {
        const tickets = await providers.zendesk!.searchTickets(`requester:${input.subject.email}`, POLICY.maxTickets + 1);
        return { summary: `${tickets.length} ticket(s)`, data: { ticketIds: tickets.slice(0, POLICY.maxTickets).map((t) => t.id), truncated: tickets.length > POLICY.maxTickets } satisfies Inventory["support"] };
      },
    },
  ],

  plan({ input }, results) {
    const inv: Inventory = { crm: out(results, "crm") ?? null, billing: out(results, "billing") ?? null, support: out(results, "support") ?? null };
    const { complete, missing } = completeness(inv);
    const deadline = deadlineOf(input);
    const ref = shortHash("dsar", input.subject.email).slice(0, 10);
    const actions: PlannedAction<Input>[] = [];
    const record = "asana.dsar_record";
    actions.push({
      id: record,
      kind: "asana.dsar_record",
      provider: "asana",
      agent: "crm",
      gate: "auto",
      summary: { requestId: input.requestId, deadline: deadline.slice(0, 10), complete },
      async execute({ providers }) {
        const notes = [
          `${input.regulation.toUpperCase()} access request ${input.requestId}, received ${input.receivedAt.slice(0, 10)}, due ${deadline.slice(0, 10)}. Subject ref ${ref}.`,
          complete ? `Found: ${inv.crm!.contactIds.length} CRM contact(s), ${inv.billing!.customerIds.length} billing customer(s) with ${inv.billing!.invoiceIds.length} invoice(s), ${inv.support!.ticketIds.length} support ticket(s).` : `Discovery incomplete (${missing.join(", ")}): nothing is exported until every system is searched.`,
        ];
        const t = await providers.asana!.createTask({ name: `${input.requestId}: ${input.regulation.toUpperCase()} access request, due ${deadline.slice(0, 10)}`, notes: notes.join("\n"), workspace: input.dsarWorkspace, due_on: deadline.slice(0, 10) });
        return { ref: t.gid };
      },
    });
    if (!complete) {
      actions.push({
        id: "slack.post_blocked",
        kind: "slack.post_blocked",
        provider: "slack",
        agent: "crm",
        gate: "auto",
        summary: { missing },
        async execute({ providers }) {
          const m = await providers.slack!.postMessage(input.privacyChannel, `:warning: ${input.requestId}: discovery incomplete (${missing.join(", ")}). Nothing exported; re-run once the system is reachable. Due ${deadline.slice(0, 10)}.`);
          return { ref: m.ts };
        },
      });
      return actions;
    }

    const verify = `privacy.verify_identity:${input.requestId}`;
    const upload = `box.upload_export:${input.requestId}`;
    const review = `privacy.approve_export:${input.requestId}`;
    const share = `box.share_link:${input.requestId}`;
    const draft = `gmail.draft_response:${input.requestId}`;
    actions.push({
      id: verify,
      kind: "privacy.verify_identity",
      provider: "asana",
      agent: "crm",
      gate: "auto",
      summary: { requestId: input.requestId, meaning: "approve = identity confirmed" },
      awaitSignal: { from: input.verifiers, deadline: new Date(Date.parse(input.receivedAt) + POLICY.verifyWithinDays * DAY).toISOString(), onDeadline: "reject" },
      requires: [record],
      async execute({ providers, applied, signal }) {
        await providers.asana!.comment(applied[record]!.ref, `Identity confirmed by ${signal?.by}${signal?.note ? `: ${signal.note}` : ""}.`);
        return { ref: applied[record]!.ref, detail: { by: signal?.by } };
      },
    });
    actions.push({
      id: upload,
      kind: "box.upload_export",
      provider: "box",
      agent: "crm",
      gate: "auto",
      summary: { requestId: input.requestId, file: exportName(input.requestId) },
      requires: [verify],
      async execute({ providers }) {
        const box = providers.box!;
        const existing = (await box.search(exportName(input.requestId), input.exportFolderId)).find((f) => f.name === exportName(input.requestId));
        if (existing) return { ref: existing.id, detail: { reused: true } };
        const pkg = await assemble(providers, input, inv);
        const f = await box.upload(input.exportFolderId, exportName(input.requestId), pkg.body);
        return { ref: f.id, detail: { sha256: pkg.sha256, counts: pkg.counts } };
      },
      async reconcile({ providers }, receipt) {
        const f = await providers.box!.getFile(receipt.ref);
        return f.name === exportName(input.requestId) ? { status: "match" } : { status: "drift", detail: `file is now ${f.name}` };
      },
    });
    actions.push({
      id: review,
      kind: "privacy.approve_export",
      provider: "asana",
      agent: "crm",
      gate: "auto",
      summary: { requestId: input.requestId, meaning: "approve = export reviewed, release it" },
      awaitSignal: { from: input.analysts, distinctFrom: [verify], deadline, onDeadline: "reject" },
      requires: [upload],
      async execute({ providers, applied, signal }) {
        await providers.asana!.comment(applied[record]!.ref, `Export ${applied[upload]!.ref} reviewed and released by ${signal?.by}.`);
        return { ref: applied[upload]!.ref, detail: { by: signal?.by, at: signal?.at } };
      },
    });
    actions.push({
      id: share,
      kind: "box.share_link",
      provider: "box",
      agent: "crm",
      gate: "auto",
      summary: { requestId: input.requestId, expiresInDays: POLICY.linkDays },
      requires: [review],
      async execute({ providers, applied }) {
        // The link runs from the release, on the engine's clock.
        const releasedAt = Date.parse(String(applied[review]!.detail?.at));
        const l = await providers.box!.createSharedLink(applied[upload]!.ref, new Date(releasedAt + POLICY.linkDays * DAY).toISOString());
        if (!l.url) throw new FatalError("Box returned no shared link");
        return { ref: l.url };
      },
    });
    actions.push({
      id: draft,
      kind: "gmail.draft_response",
      provider: "gmail",
      agent: "crm",
      gate: "auto",
      summary: { requestId: input.requestId, sent: false },
      requires: [share],
      async execute({ providers, applied, runId }) {
        const d = await providers.gmail!.createDraft({
          to: input.subject.email,
          subject: `Your data access request ${input.requestId}`,
          body: `Hello${input.subject.name ? ` ${input.subject.name}` : ""},\n\nYou asked for a copy of the personal data ACME holds about you. It is available for ${POLICY.linkDays} days at:\n${applied[share]!.ref}\n\nIt covers our CRM, billing and support systems. Reply to this email if anything is missing.\n\nACME Privacy Team`,
          messageId: messageId(runId, "dsar-response"),
        });
        return { ref: d.id };
      },
    });
    const pending = (statuses: Record<string, string>) => {
      if (statuses[draft] === "applied") throw new SkipAction("response drafted");
      if (statuses[verify] === "skipped" || statuses[review] === "skipped") throw new SkipAction("request closed without an export");
    };
    actions.push({
      id: `slack.remind:${input.requestId}`,
      kind: "slack.remind",
      provider: "slack",
      agent: "crm",
      gate: "auto",
      summary: { requestId: input.requestId, daysBefore: POLICY.remindDaysBefore },
      waitUntil: new Date(Date.parse(deadline) - POLICY.remindDaysBefore * DAY).toISOString(),
      async execute({ providers, statuses }) {
        pending(statuses);
        const waiting = statuses[verify] === "awaiting_signal" ? "identity confirmation" : statuses[review] === "awaiting_signal" ? "export review" : "the export";
        const m = await providers.slack!.postMessage(input.privacyChannel, `:hourglass: ${input.requestId} is due ${deadline.slice(0, 10)} (${POLICY.remindDaysBefore} days). Waiting on ${waiting}.`);
        return { ref: m.ts };
      },
    });
    actions.push({
      id: `privacy.escalate:${input.requestId}`,
      kind: "privacy.escalate",
      provider: "slack",
      agent: "crm",
      gate: "auto",
      summary: { requestId: input.requestId, daysBefore: POLICY.escalateDaysBefore },
      waitUntil: new Date(Date.parse(deadline) - POLICY.escalateDaysBefore * DAY).toISOString(),
      async execute({ providers, statuses, applied }) {
        pending(statuses);
        await providers.asana!.comment(applied[record]!.ref, `Escalated: ${POLICY.escalateDaysBefore} days to the statutory deadline with no response drafted.`);
        const m = await providers.slack!.postMessage(input.privacyChannel, `:rotating_light: ${input.requestId} misses its ${input.regulation.toUpperCase()} deadline in ${POLICY.escalateDaysBefore} days (${deadline.slice(0, 10)}). DPO attention needed.`);
        return { ref: m.ts };
      },
    });
    return actions;
  },

  output({ input }, results) {
    const inv: Inventory = { crm: out(results, "crm") ?? null, billing: out(results, "billing") ?? null, support: out(results, "support") ?? null };
    const c = completeness(inv);
    return c.complete
      ? { mode: "export", deadline: deadlineOf(input).slice(0, 10), crm: inv.crm!.contactIds.length, customers: inv.billing!.customerIds.length, invoices: inv.billing!.invoiceIds.length, tickets: inv.support!.ticketIds.length }
      : { mode: "blocked", missing: c.missing };
  },

  catalog: [
    { kind: "asana.dsar_record", provider: "asana", gate: "auto", description: "Request record with the statutory deadline (no personal data)" },
    { kind: "slack.post_blocked", provider: "slack", gate: "auto", description: "Discovery incomplete: nothing exported" },
    { kind: "privacy.verify_identity", provider: "asana", gate: "auto", description: "Signal: a privacy team member confirms the requester's identity" },
    { kind: "box.upload_export", provider: "box", gate: "auto", description: "Assemble the export from source systems and upload it once" },
    { kind: "privacy.approve_export", provider: "asana", gate: "auto", description: "Signal: an analyst other than the verifier reviews and releases the export" },
    { kind: "box.share_link", provider: "box", gate: "auto", description: "Expiring download link" },
    { kind: "gmail.draft_response", provider: "gmail", gate: "auto", description: "Response draft to the requester (not sent)" },
    { kind: "slack.remind", provider: "slack", gate: "auto", description: "Reminder ahead of the statutory deadline" },
    { kind: "privacy.escalate", provider: "slack", gate: "auto", description: "Escalation just before the deadline" },
  ],
};
