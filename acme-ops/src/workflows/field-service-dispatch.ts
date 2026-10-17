import { z } from "zod";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { firstFreeSlot, type Slot } from "../providers/google";
import { LIVE_SUB_STATES } from "../providers/stripe";
import { Approvers, ChannelId, Email, out, plain, shortHash } from "./shared";

// Service · field-service.
// Trigger: a monitoring alarm from an installed asset (e.g. a transformer monitor).

const Input = z.object({
  alarm: z.object({
    id: z.string().min(1).max(100),
    site: z.string().min(1).max(200),
    asset: z.string().min(1).max(200),
    severity: z.enum(["critical", "major", "minor"]),
    description: z.string().max(2000).default(""),
  }),
  account: z.object({ email: Email }),
  sitePhone: z.string().regex(/^\+[1-9]\d{7,14}$/, "E.164 phone number like +15125550100"),
  technicianCalendars: z.array(z.string().min(3).max(200)).min(1).max(10),
  afterHours: z.boolean().default(false),
  dispatchChannel: ChannelId,
  workspace: z.string().min(1).default("acme-field-service"),
  fromNumber: z.string().regex(/^\+[1-9]\d{7,14}$/).default("+15125550199"),
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

interface Availability {
  technician?: string;
  slot?: Slot;
}
interface Coverage {
  customerId: string | null;
  covered: boolean;
}
interface Dispatch {
  covered: boolean;
  needsApproval: boolean;
  reasons: string[];
  sms: string;
}

const VISIT_MINUTES: Record<Input["alarm"]["severity"], number> = { critical: 120, major: 120, minor: 60 };
const SEARCH_DAYS: Record<Input["alarm"]["severity"], number> = { critical: 1, major: 3, minor: 5 };

export const fieldServiceDispatch: WorkflowDef<Input> = {
  id: "field-service-dispatch",
  title: "Field service dispatch",
  org: "Service",
  team: "field-service",
  description:
    "Turn an asset alarm into a dispatch: find the earliest free technician, check the service contract in Stripe, open the Asana work order, text the site contact and post to Slack. Booking an after-hours or uncovered (billable) visit waits for approval.",
  input: Input,
  agents: [
    {
      name: "technician-availability",
      needs: ["calendar"],
      async run({ input, providers, startedAt }) {
        const until = new Date(startedAt.getTime() + 14 * 86_400_000).toISOString();
        const sev = input.alarm.severity;
        let best: Availability = {};
        for (const tech of input.technicianCalendars) {
          const busy = await providers.calendar!.busy(tech, startedAt.toISOString(), until);
          const slot = firstFreeSlot(busy, startedAt, VISIT_MINUTES[sev], SEARCH_DAYS[sev]);
          if (slot && (!best.slot || slot.start < best.slot.start)) best = { technician: tech, slot };
        }
        return { summary: best.slot ? `${best.technician} at ${best.slot.start}` : "no technician free in the window", data: best };
      },
    },
    {
      name: "service-contract",
      needs: ["stripe"],
      async run({ input, providers }) {
        const c = await providers.stripe!.findCustomerByEmail(input.account.email);
        const subs = c ? (await providers.stripe!.listSubscriptions(c.id)).filter((s) => s.customer === c.id) : [];
        const data: Coverage = { customerId: c?.id ?? null, covered: subs.some((s) => LIVE_SUB_STATES.has(s.status)) };
        return { summary: data.covered ? "under service contract" : "no live contract: billable", data };
      },
    },
    {
      name: "site-account",
      needs: ["hubspot"],
      async run({ input, providers }) {
        const c = await providers.hubspot!.findByEmail(input.account.email);
        return { summary: c ? `HubSpot contact ${c.id}` : "not in HubSpot", data: { company: c?.properties.company ?? null } };
      },
    },
  ],

  compose: {
    name: "dispatch-planner",
    async run({ input }, results) {
      const cov = out<Coverage>(results, "service-contract");
      const av = out<Availability>(results, "technician-availability");
      // Unknown coverage is treated as billable: never dispatch free work by accident.
      const covered = cov?.covered ?? false;
      const reasons: string[] = [];
      if (input.afterHours) reasons.push("after-hours callout");
      if (!covered) reasons.push(cov ? "no service contract (billable)" : "contract unverified (treated as billable)");
      const sms = `ACME Service: alarm ${plain(input.alarm.id, 40)} at ${plain(input.alarm.site, 60)} received. ${av?.slot ? `A technician is being scheduled for ${av.slot.start.slice(0, 16).replace("T", " ")} UTC; we'll confirm shortly.` : "We're arranging a technician and will call you."}`;
      const data: Dispatch = { covered, needsApproval: reasons.length > 0, reasons, sms };
      return { summary: data.needsApproval ? `needs approval: ${reasons.join(", ")}` : "auto-dispatch", data };
    },
  },

  plan({ input }, results) {
    const d = out<Dispatch>(results, "dispatch-planner");
    const av = out<Availability>(results, "technician-availability");
    if (!d) return [];
    const key = shortHash(input.alarm.id);
    const actions: PlannedAction<Input>[] = [];
    actions.push({
      id: "asana.create_work_order",
      kind: "asana.create_work_order",
      provider: "asana",
      agent: "dispatch-planner",
      gate: "auto",
      summary: { alarm: input.alarm.id, site: input.alarm.site, severity: input.alarm.severity, covered: d.covered, technician: av?.technician ?? null },
      async execute({ providers }) {
        const t = await providers.asana!.createTask({
          name: `WO ${input.alarm.severity.toUpperCase()} ${plain(input.alarm.asset, 60)} @ ${plain(input.alarm.site, 60)}`,
          notes: `Alarm ${input.alarm.id}: ${plain(input.alarm.description, 1500)}\nCoverage: ${d.covered ? "service contract" : "billable"}\nProposed: ${av?.technician ?? "unassigned"} ${av?.slot?.start ?? ""}`,
          workspace: input.workspace,
          due_on: av?.slot?.start.slice(0, 10),
        });
        return { ref: t.gid };
      },
      async reconcile({ providers }, receipt) {
        const t = await providers.asana!.getTask(receipt.ref);
        return t.name?.includes(input.alarm.severity.toUpperCase()) ? { status: "match" } : { status: "drift", detail: `work order renamed to "${t.name}"` };
      },
    });
    actions.push({
      id: "twilio.notify_site",
      kind: "twilio.notify_site",
      provider: "twilio",
      agent: "dispatch-planner",
      gate: "auto",
      summary: { to: input.sitePhone, text: d.sms },
      async execute({ providers }) {
        const m = await providers.twilio!.sendSms(input.sitePhone, input.fromNumber, d.sms);
        return { ref: m.sid, detail: { status: m.status } };
      },
      async reconcile({ providers }, receipt) {
        const m = await providers.twilio!.getMessage(receipt.ref);
        return ["failed", "undelivered"].includes(m.status) ? { status: "drift", detail: `SMS ${m.status}` } : { status: "match" };
      },
    });
    actions.push({
      id: "slack.post_dispatch",
      kind: "slack.post_dispatch",
      provider: "slack",
      agent: "dispatch-planner",
      gate: "auto",
      summary: { channel: input.dispatchChannel, alarm: input.alarm.id, needsApproval: d.needsApproval },
      async execute({ providers }) {
        const m = await providers.slack!.postMessage(
          input.dispatchChannel,
          `:rotating_light: ${input.alarm.severity.toUpperCase()} alarm ${plain(input.alarm.id, 40)}: ${plain(input.alarm.asset, 60)} at ${plain(input.alarm.site, 60)}. ${av?.slot ? `${av.technician} free ${av.slot.start}.` : "No technician free in the window."} ${d.needsApproval ? `Booking needs approval (${d.reasons.join(", ")}).` : "Booking automatically (under contract)."}`,
        );
        return { ref: m.ts, detail: { channel: m.channel } };
      },
    });
    if (av?.slot && av.technician) {
      const slot = av.slot;
      const tech = av.technician;
      actions.push({
        id: "calendar.book_technician",
        kind: "calendar.book_technician",
        provider: "calendar",
        agent: "technician-availability",
        gate: d.needsApproval ? "approval" : "auto",
        summary: { technician: tech, start: slot.start, end: slot.end, site: input.alarm.site, reasons: d.reasons },
        async execute({ providers, runId }) {
          const ev = await providers.calendar!.insertEvent(
            tech,
            { summary: `Field visit: ${plain(input.alarm.asset, 60)} @ ${plain(input.alarm.site, 60)}`, description: `Alarm ${input.alarm.id} (${input.alarm.severity}). Site phone ${input.sitePhone}.`, start: slot.start, end: slot.end, privateKey: `${runId}:visit:${key}` },
            "none",
          );
          return { ref: ev.id, detail: { start: slot.start } };
        },
      });
    }
    return actions;
  },

  output({ input }, results) {
    const d = out<Dispatch>(results, "dispatch-planner");
    const av = out<Availability>(results, "technician-availability");
    return {
      alarm: input.alarm.id,
      severity: input.alarm.severity,
      covered: d?.covered ?? false,
      needsApproval: d?.needsApproval ?? true,
      reasons: d?.reasons ?? [],
      technician: av?.technician ?? null,
      visitStart: av?.slot?.start ?? null,
    };
  },

  catalog: [
    { kind: "asana.create_work_order", provider: "asana", gate: "auto", description: "Open the field work order" },
    { kind: "twilio.notify_site", provider: "twilio", gate: "auto", description: "Text the site contact that the alarm is being handled" },
    { kind: "slack.post_dispatch", provider: "slack", gate: "auto", description: "Post the dispatch to the field-service channel" },
    { kind: "calendar.book_technician", provider: "calendar", gate: "approval", description: "Book the technician (automatic under contract in hours; approval after hours or when billable)" },
  ],
};
