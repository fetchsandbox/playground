import { z } from "zod";
import { firstFreeSlot, type Slot } from "../providers/google";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { Approvers, ChannelId, Email, messageId, out, plain } from "./shared";

// Quality org · supplier-quality team.
// Trigger: incoming inspection rejects a lot. Opens the corrective action (CAPA),
// asks the supplier for an 8D, holds the review, and — for critical or
// high-reject lots — proposes a supplier hold for approval.

const Input = z.object({
  ncrId: z.string().regex(/^[A-Z0-9-]{3,40}$/, "NCR id like NCR-2026-0142"),
  supplier: z.object({ name: z.string().min(1).max(200), email: Email }),
  part: z.string().min(1).max(100),
  lot: z.string().min(1).max(100),
  defect: z.string().min(3).max(2000),
  qtyInspected: z.number().int().min(1).max(10_000_000),
  qtyRejected: z.number().int().min(1).max(10_000_000),
  severity: z.enum(["minor", "major", "critical"]),
  qualityWorkspace: z.string().min(1).default("acme-quality"),
  qualityCalendarId: z.string().min(1).default("primary"),
  purchasingChannel: ChannelId,
  approvers: Approvers,
}).refine((i) => i.qtyRejected <= i.qtyInspected, { message: "qtyRejected cannot exceed qtyInspected", path: ["qtyRejected"] });
type Input = z.infer<typeof Input>;

/** Days the supplier gets to return an 8D, by severity. */
export const RESPONSE_DAYS = { critical: 7, major: 14, minor: 30 } as const;
/** Reject rate that triggers a hold proposal regardless of severity. */
export const HOLD_REJECT_RATE = 0.1;

export function holdReasons(i: Pick<Input, "severity" | "qtyInspected" | "qtyRejected">, priorOpen: number): string[] {
  const reasons: string[] = [];
  if (i.severity === "critical") reasons.push("critical defect");
  if (i.qtyRejected / i.qtyInspected >= HOLD_REJECT_RATE) reasons.push(`reject rate ${Math.round((i.qtyRejected / i.qtyInspected) * 100)}%`);
  if (priorOpen >= 2) reasons.push(`${priorOpen} open CAPAs`);
  return reasons;
}

export const supplierNcr: WorkflowDef<Input> = {
  id: "supplier-ncr",
  title: "Supplier nonconformance and corrective action",
  org: "Quality",
  team: "supplier-quality",
  description:
    "On a rejected lot: open the CAPA in Asana with a due date by severity, draft the 8D request to the supplier, hold the review on the quality calendar and alert Purchasing; a supplier hold for critical or high-reject lots waits for approval.",
  input: Input,
  agents: [
    {
      name: "supplier-contact",
      needs: ["hubspot"],
      async run({ input, providers }) {
        const c = await providers.hubspot!.findByEmail(input.supplier.email);
        return { summary: c ? `HubSpot contact ${c.id}` : "supplier contact not in HubSpot", data: { contactId: c?.id } };
      },
    },
    {
      name: "capa-history",
      needs: ["asana"],
      async run({ input, providers }) {
        // Open CAPAs whose title names this supplier.
        const { body } = await providers.asana!.http.request<any>("GET", "/tasks", { query: { workspace: input.qualityWorkspace, completed_since: "now", opt_fields: "name,completed" } });
        const name = input.supplier.name.toLowerCase();
        const open = (body?.data ?? []).filter((t: any) => !t.completed && String(t.name ?? "").toLowerCase().includes(`capa`) && String(t.name ?? "").toLowerCase().includes(name)).length;
        return { summary: `${open} open CAPA(s) for this supplier`, data: { open } };
      },
    },
    {
      name: "review-slot",
      needs: ["calendar"],
      async run({ input, providers, startedAt }) {
        const busy = await providers.calendar!.busy(input.qualityCalendarId, startedAt.toISOString(), new Date(startedAt.getTime() + 14 * 86_400_000).toISOString());
        const slot = firstFreeSlot(busy, startedAt, 60, RESPONSE_DAYS[input.severity] > 7 ? 10 : 5);
        return { summary: slot ? `8D review ${slot.start}` : "no free hour", data: { slot } };
      },
    },
  ],

  plan({ input, startedAt }, results) {
    const history = out<{ open: number }>(results, "capa-history");
    const slot = out<{ slot?: Slot }>(results, "review-slot")?.slot;
    const due = new Date(startedAt.getTime() + RESPONSE_DAYS[input.severity] * 86_400_000).toISOString().slice(0, 10);
    const reasons = holdReasons(input, history?.open ?? 0);
    const rate = `${Math.round((input.qtyRejected / input.qtyInspected) * 1000) / 10}%`;
    const title = `CAPA ${input.ncrId}: ${plain(input.supplier.name, 80)} — ${plain(input.part, 60)} lot ${plain(input.lot, 40)}`;
    const actions: PlannedAction<Input>[] = [];

    actions.push({
      id: "asana.open_capa",
      kind: "asana.open_capa",
      provider: "asana",
      agent: "capa-history",
      gate: "auto",
      summary: { ncrId: input.ncrId, due, severity: input.severity },
      async execute({ providers }) {
        const t = await providers.asana!.createTask({
          name: title,
          notes: [`Defect: ${plain(input.defect, 1500)}`, `Rejected ${input.qtyRejected}/${input.qtyInspected} (${rate})`, `Severity: ${input.severity}`, `8D due: ${due}`].join("\n"),
          workspace: input.qualityWorkspace,
          due_on: due,
        });
        return { ref: t.gid, detail: { due } };
      },
      async reconcile({ providers }, r) {
        const t = await providers.asana!.getTask(r.ref);
        if (t.completed) return { status: "drift", detail: "CAPA closed" };
        return t.due_on === due ? { status: "match" } : { status: "drift", detail: `due date is ${t.due_on}` };
      },
    });

    actions.push({
      id: "gmail.draft_8d_request",
      kind: "gmail.draft_8d_request",
      provider: "gmail",
      agent: "supplier-contact",
      gate: "auto",
      summary: { to: input.supplier.email, due, sent: false },
      async execute({ providers, runId }) {
        const d = await providers.gmail!.createDraft({
          to: input.supplier.email,
          subject: `${input.ncrId}: 8D corrective action requested — ${plain(input.part, 60)} lot ${plain(input.lot, 40)}`,
          body: `Hello ${plain(input.supplier.name, 100)},\n\nIncoming inspection rejected ${input.qtyRejected} of ${input.qtyInspected} units of ${plain(input.part, 60)}, lot ${plain(input.lot, 40)} (${rate}).\nDefect: ${plain(input.defect, 1500)}\n\nPlease return an 8D report with containment and root cause by ${due}.\n\nACME Supplier Quality`,
          messageId: messageId(runId, "8d"),
        });
        return { ref: d.id };
      },
    });

    if (slot) {
      actions.push({
        id: "calendar.hold_8d_review",
        kind: "calendar.hold_8d_review",
        provider: "calendar",
        agent: "review-slot",
        gate: "auto",
        summary: { calendarId: input.qualityCalendarId, start: slot.start, attendees: [] },
        async execute({ providers, runId }) {
          const ev = await providers.calendar!.insertEvent(
            input.qualityCalendarId,
            { summary: `8D review: ${input.ncrId}`, description: title, start: slot.start, end: slot.end, privateKey: `${runId}:8d` },
            "none",
          );
          return { ref: ev.id };
        },
      });
    }

    actions.push({
      id: "slack.post_ncr",
      kind: "slack.post_ncr",
      provider: "slack",
      agent: "capa-history",
      gate: "auto",
      summary: { channel: input.purchasingChannel, ncrId: input.ncrId, holdProposed: reasons.length > 0 },
      async execute({ providers }) {
        const text = `*${input.ncrId}* ${input.severity.toUpperCase()} — ${plain(input.supplier.name, 80)}, ${plain(input.part, 60)} lot ${plain(input.lot, 40)}: ${input.qtyRejected}/${input.qtyInspected} rejected (${rate}). 8D due ${due}.${reasons.length ? ` Supplier hold proposed (${reasons.join(", ")}), awaiting approval.` : ""}`;
        const m = await providers.slack!.postMessage(input.purchasingChannel, text);
        return { ref: m.ts };
      },
    });

    if (reasons.length) {
      actions.push({
        id: "gmail.draft_supplier_hold",
        kind: "gmail.draft_supplier_hold",
        provider: "gmail",
        agent: "capa-history",
        gate: "approval",
        summary: { to: input.supplier.email, reasons, sent: false },
        async execute({ providers, runId }) {
          const d = await providers.gmail!.createDraft({
            to: input.supplier.email,
            subject: `${input.ncrId}: ACME supplier hold — ${plain(input.part, 60)}`,
            body: `Hello ${plain(input.supplier.name, 100)},\n\nEffective immediately ACME is placing shipments of ${plain(input.part, 60)} on hold (${reasons.join(", ")}). The hold lifts when your 8D for ${input.ncrId} is accepted.\n\nACME Supplier Quality`,
            messageId: messageId(runId, "hold"),
          });
          return { ref: d.id };
        },
      });
      actions.push({
        id: "slack.announce_hold",
        kind: "slack.announce_hold",
        provider: "slack",
        agent: "capa-history",
        gate: "approval",
        summary: { channel: input.purchasingChannel, supplier: input.supplier.name },
        async execute({ providers }) {
          const m = await providers.slack!.postMessage(input.purchasingChannel, `:no_entry: Supplier hold approved: ${plain(input.supplier.name, 80)} — do not release POs for ${plain(input.part, 60)} until ${input.ncrId} closes.`);
          return { ref: m.ts };
        },
      });
    }
    return actions;
  },

  output({ input, startedAt }, results) {
    const history = out<{ open: number }>(results, "capa-history");
    return {
      ncrId: input.ncrId,
      rejectRate: Math.round((input.qtyRejected / input.qtyInspected) * 1000) / 1000,
      responseDue: new Date(startedAt.getTime() + RESPONSE_DAYS[input.severity] * 86_400_000).toISOString().slice(0, 10),
      priorOpenCapas: history?.open ?? null,
      holdReasons: holdReasons(input, history?.open ?? 0),
    };
  },

  catalog: [
    { kind: "asana.open_capa", provider: "asana", gate: "auto", description: "Open the CAPA task with the 8D due date" },
    { kind: "gmail.draft_8d_request", provider: "gmail", gate: "auto", description: "Draft (not send) the 8D request to the supplier" },
    { kind: "calendar.hold_8d_review", provider: "calendar", gate: "auto", description: "Hold the 8D review on the quality calendar (no attendees)" },
    { kind: "slack.post_ncr", provider: "slack", gate: "auto", description: "Alert Purchasing about the rejected lot" },
    { kind: "gmail.draft_supplier_hold", provider: "gmail", gate: "approval", description: "Draft the formal supplier hold notice" },
    { kind: "slack.announce_hold", provider: "slack", gate: "approval", description: "Tell Purchasing to stop releasing POs" },
  ],
};
