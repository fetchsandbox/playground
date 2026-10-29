import { z } from "zod";
import { SkipAction } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import defaults from "../../policies/new-hire-paperwork.json";
import { DAY, fill, firstMatch, onDate, storeOf, StorePolicy, templateString } from "./lib/documents";
import { Email, out } from "./shared";

// People · people-ops.
// Trigger: a hire is finalized in the HRIS or ATS.
// The new hire gets one DocuSign envelope holding the packet their country
// and employment type call for (server templates, in order), countersigned by
// the People team when the policy says so. DocuSign sends its own reminders
// and expires the envelope after the start date. Then:
//   - DocuSign Connect signals completion; the runtime re-reads the envelope
//     (the signal alone is never trusted) and files the signed packet with its
//     certificate in the employee's folder in Box or Dropbox;
//   - before the start date (7 and 2 days by default) People Ops is told if
//     the packet still isn't signed;
//   - a declined or voided envelope, or no signature by the start date, is
//     escalated to People Ops, naming the manager, so day one isn't the first
//     time anyone notices;
//   - a hire no packet matches, or whose start date is too close, gets nothing
//     sent and People Ops is told.
// Packets, template ids, reminder cadence, escalation days, the countersigner
// and folder layout are policy (policies/new-hire-paperwork.json).

const FOLDER_VARS = ["country", "year", "employee", "hireId", "employmentType"] as const;
const EMPLOYMENT = ["full_time", "part_time", "intern", "contractor"] as const;

export const Policy = z.object({
  store: StorePolicy,
  packets: z
    .array(
      z.object({
        name: z.string().min(1),
        match: z.object({ country: z.array(z.string().length(2)).optional(), employmentType: z.array(z.enum(EMPLOYMENT)).optional() }).describe("Conditions; a missing or empty list matches any value"),
        templates: z.array(z.string().min(1)).min(1).max(20).describe("DocuSign server template ids, in document order"),
      }),
    )
    .min(1)
    .describe("Packets by country and employment type; first match wins"),
  signerRole: z.string().min(1).describe("Template role the new hire fills"),
  countersigner: z.object({ roleName: z.string().min(1), name: z.string().min(1), email: z.email() }).nullable().describe("Signs after the new hire (null: nobody)"),
  subject: templateString(["firstName", "employee"], "Envelope subject"),
  minLeadDays: z.number().int().min(0).max(30).describe("Don't send when the start date is fewer than this many days away; People Ops is told instead"),
  docusign: z
    .object({
      reminderDelayDays: z.number().int().min(1).max(30).describe("First DocuSign reminder after this many days"),
      reminderEveryDays: z.number().int().min(1).max(30).describe("Then every this many days"),
      expireDaysAfterStart: z.number().int().min(0).max(60).describe("The envelope expires this many days after the start date"),
    })
    .describe("DocuSign's own reminders and expiry, set on the envelope"),
  connectSender: z.string().min(1).describe("User id your DocuSign Connect adapter signals completion as"),
  escalateDaysBeforeStart: z.array(z.number().int().min(1).max(60)).describe("Tell People Ops this many days before the start date if the packet isn't signed"),
  peopleChannel: z.string().regex(/^[CG][A-Z0-9]{6,}$/).describe("Slack channel for People Ops"),
  folder: templateString(FOLDER_VARS, "Folder for the signed packet"),
  fileName: templateString(["date", "employee", "hireId"], "File name"),
});
export type Policy = z.infer<typeof Policy>;

const Input = z.object({
  hireId: z.string().regex(/^[\w-]{3,40}$/, "HRIS hire id"),
  employee: z.object({ name: z.string().trim().min(1).max(120), email: Email }),
  country: z.string().regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2"),
  employmentType: z.enum(EMPLOYMENT),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  manager: z.object({ name: z.string().trim().min(1).max(120), email: Email }),
});
type Input = z.infer<typeof Input>;

export interface Existing {
  envelopeId: string;
  status: string;
}

export const externalId = (hireId: string) => `nh-${hireId}`;
const live = (e: { status: string }) => !["voided", "declined"].includes(e.status);

export const newHirePaperwork: WorkflowDef<Input> = {
  id: "new-hire-paperwork",
  title: "New-hire paperwork",
  org: "People",
  team: "people-ops",
  description:
    "Send a new hire the DocuSign packet their country and employment type call for, with DocuSign reminders and expiry; file the signed packet in Box or Dropbox when Connect reports completion (re-checked with DocuSign); escalate to People Ops before the start date while unsigned, and on decline, void or no signature by day one; packets, templates, cadence and folders are policy.",
  input: Input,
  policy: { schema: Policy as z.ZodType<unknown>, defaults },
  audit: true,
  tickEvery: "rate(1 hour)",
  agents: [
    {
      name: "envelopes",
      needs: ["docusign"],
      async run({ input, providers, startedAt }) {
        // An envelope already sent for this hire (a re-delivered event, a new run) is reused, never re-sent.
        const from = new Date(startedAt.getTime() - 180 * DAY).toISOString();
        const found = (await providers.docusign!.findByExternalId(externalId(input.hireId), from)).filter(live);
        const existing: Existing | null = found[0] ? { envelopeId: found[0].envelopeId, status: found[0].status } : null;
        return { summary: existing ? `envelope ${existing.envelopeId} already ${existing.status}` : "no envelope sent yet", data: existing };
      },
    },
  ],

  plan({ input, policy, startedAt }, results) {
    const p = policy as Policy;
    const existing = out<Existing | null>(results, "envelopes");
    const post = (id: string, text: string, extra: Partial<PlannedAction<Input>> = {}): PlannedAction<Input> => ({
      id,
      kind: id.split(":")[0]!,
      provider: "slack",
      agent: "envelopes",
      gate: "auto",
      summary: { hireId: input.hireId },
      async execute({ providers }) {
        return { ref: (await providers.slack!.postMessage(p.peopleChannel, text)).ts };
      },
      ...extra,
    });
    // No packet means nothing to send, whatever DocuSign says.
    const packet = firstMatch(p.packets, { country: input.country, employmentType: input.employmentType });
    if (!packet) return [post("slack.post_no_packet", `:grey_question: No paperwork packet matches ${input.employee.name} (${input.hireId}: ${input.country}, ${input.employmentType}); nothing was sent. Add a packet to the policy or send it by hand.`)];
    if (existing === undefined) return [post("slack.post_blocked", `:warning: Couldn't check DocuSign for ${input.employee.name} (${input.hireId}); no paperwork was sent. Re-run once DocuSign is reachable.`)];
    const startAt = Date.parse(onDate(input.startDate));
    const leadDays = Math.floor((startAt - startedAt.getTime()) / DAY);
    if (!existing && leadDays < p.minLeadDays) return [post("slack.post_too_late", `:rotating_light: ${input.employee.name} (${input.hireId}) starts ${input.startDate}, ${Math.max(0, leadDays)} day(s) away, under the ${p.minLeadDays}-day minimum. Paperwork was not sent automatically; handle it with them directly.`)];

    const send = "docusign.send_packet";
    const complete = "docusign.packet_completed";
    const first = input.employee.name.split(/\s+/)[0]!;
    const folder = fill(p.folder, { country: input.country, year: input.startDate.slice(0, 4), employee: input.employee.name, hireId: input.hireId, employmentType: input.employmentType });
    const actions: PlannedAction<Input>[] = [
      {
        id: send,
        kind: send,
        provider: "docusign",
        agent: "envelopes",
        gate: "auto",
        summary: { packet: packet.name, templates: packet.templates.length, to: input.employee.email, countersigned: !!p.countersigner },
        async execute({ providers }) {
          const ds = providers.docusign!;
          if (existing) return { ref: existing.envelopeId, detail: { reused: true } };
          // Re-check right before sending: a concurrent run may have sent it since the agent looked.
          const again = (await ds.findByExternalId(externalId(input.hireId), new Date(startedAt.getTime() - 180 * DAY).toISOString())).find(live);
          if (again) return { ref: again.envelopeId, detail: { reused: true } };
          const env = await ds.createFromTemplates({
            subject: fill(p.subject, { firstName: first, employee: input.employee.name }),
            templateIds: packet.templates,
            roles: [{ roleName: p.signerRole, email: input.employee.email, name: input.employee.name }, ...(p.countersigner ? [p.countersigner] : [])],
            externalId: externalId(input.hireId),
            reminders: { delayDays: p.docusign.reminderDelayDays, everyDays: p.docusign.reminderEveryDays },
            expireDays: Math.min(120, Math.max(1, leadDays + p.docusign.expireDaysAfterStart)),
          });
          return { ref: env.envelopeId, detail: { reused: false } };
        },
      },
      {
        id: complete,
        kind: complete,
        provider: p.store.provider,
        agent: "envelopes",
        gate: "auto",
        summary: { store: p.store.provider, folder, meaning: "approve = Connect reported completed, reject = declined or voided" },
        requires: [send],
        awaitSignal: { from: [p.connectSender], deadline: new Date(startAt).toISOString(), onDeadline: "fail" },
        async execute({ providers, applied }) {
          const envelopeId = applied[send]!.ref;
          const env = await providers.docusign!.getEnvelope(envelopeId);
          // The Connect signal is a prompt, not proof: DocuSign itself must say completed.
          if (env.status !== "completed") throw new Error(`Connect reported completion but DocuSign says ${env.status}`);
          const name = fill(p.fileName, { date: (env.completedDateTime ?? new Date().toISOString()).slice(0, 10), employee: input.employee.name, hireId: input.hireId });
          const store = storeOf(providers, p.store);
          const found = await store.find(folder, name);
          if (found) return { ref: found.id, detail: { path: `${folder}/${name}`, existed: true } };
          const pdf = Buffer.from(await providers.docusign!.combinedPdfBase64(envelopeId, true), "base64");
          const doc = await store.put(folder, name, pdf);
          return { ref: doc.id, detail: { path: `${folder}/${name}`, existed: doc.existed } };
        },
        async reconcile({ providers }, receipt) {
          const path = String(receipt.detail?.path ?? "");
          const doc = await storeOf(providers, p.store).find(folder, path.slice(folder.length + 1));
          return doc ? { status: "match" } : { status: "missing", detail: `${path} is no longer in ${p.store.provider}` };
        },
      },
    ];
    for (const d of [...new Set(p.escalateDaysBeforeStart)].sort((a, b) => b - a)) {
      const when = onDate(input.startDate, -d);
      if (Date.parse(when) <= startedAt.getTime()) continue;
      actions.push(
        post(`people.unsigned_reminder:${d}`, "", {
          kind: "people.unsigned_reminder",
          summary: { hireId: input.hireId, daysBeforeStart: d },
          waitUntil: when,
          after: [send],
          async execute({ providers, statuses, applied }) {
            if (statuses[complete] !== "awaiting_signal") throw new SkipAction(`packet is ${statuses[complete]}`);
            const env = await providers.docusign!.getEnvelope(applied[send]!.ref);
            if (env.status === "completed") throw new SkipAction("signed; filing waits for Connect");
            const text = `:hourglass: ${input.employee.name} (${input.hireId}) starts ${input.startDate} (${d} day(s)) and hasn't finished their paperwork (DocuSign: ${env.status}). Manager: ${input.manager.name} <${input.manager.email}>.`;
            return { ref: (await providers.slack!.postMessage(p.peopleChannel, text)).ts };
          },
        }),
      );
    }
    actions.push(
      post("people.packet_not_completed", "", {
        kind: "people.packet_not_completed",
        summary: { hireId: input.hireId, startDate: input.startDate },
        after: [complete],
        async execute({ providers, statuses }) {
          const s = statuses[complete];
          if (s === "applied" || s === "skipped") throw new SkipAction(`packet ${s}`);
          const why = s === "rejected" ? "was declined or voided" : s === "failed" ? "isn't signed and filed by the start date" : `is ${s}`;
          return { ref: (await providers.slack!.postMessage(p.peopleChannel, `:rotating_light: ${input.employee.name}'s paperwork (${input.hireId}) ${why}. Start date ${input.startDate}; manager ${input.manager.name} <${input.manager.email}>. Follow up before they start work.`)).ts };
        },
      }),
    );
    return actions;
  },

  output({ input, policy }, results) {
    const existing = out<Existing | null>(results, "envelopes");
    const packet = firstMatch((policy as Policy).packets, { country: input.country, employmentType: input.employmentType });
    if (!packet) return { mode: "no_packet" };
    if (existing === undefined) return { mode: "blocked" };
    return { mode: existing ? "existing_envelope" : "packet", packet: packet.name, documents: packet.templates.length };
  },

  catalog: [
    { kind: "docusign.send_packet", provider: "docusign", gate: "auto", description: "Send the policy's packet (composite templates) with DocuSign reminders and expiry; reuses an envelope already sent for the hire" },
    { kind: "docusign.packet_completed", provider: "box", gate: "auto", description: "Signal: Connect reports completion (approve) or decline/void (reject); re-checked with DocuSign, then filed in Box or Dropbox" },
    { kind: "people.unsigned_reminder", provider: "slack", gate: "auto", description: "Before the start date, People Ops is told the packet isn't signed" },
    { kind: "people.packet_not_completed", provider: "slack", gate: "auto", description: "Declined, voided or unsigned by the start date: escalate, naming the manager" },
    { kind: "slack.post_no_packet", provider: "slack", gate: "auto", description: "No packet matches the hire: nothing sent" },
    { kind: "slack.post_too_late", provider: "slack", gate: "auto", description: "Start date inside the minimum lead time: nothing sent automatically" },
    { kind: "slack.post_blocked", provider: "slack", gate: "auto", description: "DocuSign unreadable: nothing sent" },
  ],
};
