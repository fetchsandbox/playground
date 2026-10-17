import { z } from "zod";
import { LIVE_SUB_STATES } from "../providers/stripe";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { Approvers, ChannelId, messageId, out, plain, shortHash } from "./shared";

// IT org · it-operations team.
// Trigger: a PagerDuty incident webhook (incident.triggered / acknowledged /
// resolved) forwarded by the control plane. Works out who is affected, keeps
// the war room and the incident timeline current, and drafts customer
// notices for approval.

const Input = z.object({
  incident: z.object({
    id: z.string().regex(/^[A-Z0-9]{3,20}$/, "PagerDuty incident id like PT4KHLK"),
    title: z.string().min(1).max(500),
    service: z.string().min(1).max(200),
    urgency: z.enum(["high", "low"]),
    status: z.enum(["triggered", "acknowledged", "resolved"]),
  }),
  /** Stripe product ids the service backs; empty = every customer with a live subscription. */
  affectedProductIds: z.array(z.string().regex(/^prod_\w+$/)).max(50).default([]),
  warRoomChannel: ChannelId,
  maxNotices: z.number().int().min(0).max(500).default(50),
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

interface Impact {
  customers: { customerId: string; email: string; name?: string }[];
}

export const incidentComms: WorkflowDef<Input> = {
  id: "incident-comms",
  title: "Incident communications",
  org: "IT",
  team: "it-operations",
  description:
    "On a PagerDuty incident: find the customers on the affected service, post the war-room update, record a timeline note on the incident, and draft customer notices (outage or resolution) for approval. Low-urgency incidents stay internal.",
  input: Input,
  agents: [
    {
      name: "customer-impact",
      needs: ["stripe"],
      async run({ input, providers }) {
        const stripe = providers.stripe!;
        const [subs, customers] = await Promise.all([stripe.listSubscriptions(), stripe.listCustomers()]);
        const wanted = new Set(input.affectedProductIds);
        const affectedIds = new Set(
          subs
            .filter((s) => LIVE_SUB_STATES.has(s.status))
            .filter((s) => !wanted.size || s.items.data.some((it) => wanted.has(String((it.price as { product?: string } | undefined)?.product ?? ""))))
            .map((s) => s.customer),
        );
        const data: Impact = {
          customers: customers
            .filter((c) => affectedIds.has(c.id) && c.email)
            .map((c) => ({ customerId: c.id, email: c.email!.toLowerCase(), name: c.name ?? undefined }))
            .sort((a, b) => a.email.localeCompare(b.email)),
        };
        return { summary: `${data.customers.length} affected customer(s)`, data };
      },
    },
    {
      name: "account-owners",
      needs: ["hubspot"],
      async run({ providers }) {
        const contacts = await providers.hubspot!.searchEq("lifecyclestage", "customer");
        const owners = Object.fromEntries(contacts.filter((c) => c.properties.email).map((c) => [c.properties.email!.toLowerCase(), c.properties.hubspot_owner_id ?? null]));
        return { summary: `${Object.keys(owners).length} CRM customers`, data: { owners } };
      },
    },
  ],

  plan({ input }, results) {
    const impact = out<Impact>(results, "customer-impact");
    const owners = out<{ owners: Record<string, string | null> }>(results, "account-owners")?.owners ?? {};
    const inc = input.incident;
    const resolved = inc.status === "resolved";
    const affected = impact?.customers ?? [];
    const impactLine = impact ? `${affected.length} customer(s) affected` : "customer impact unknown (billing data unavailable)";
    const actions: PlannedAction<Input>[] = [];

    actions.push({
      id: "slack.war_room_update",
      kind: "slack.war_room_update",
      provider: "slack",
      agent: "customer-impact",
      gate: "auto",
      summary: { channel: input.warRoomChannel, incidentId: inc.id, status: inc.status },
      async execute({ providers }) {
        const text = `${resolved ? ":white_check_mark: RESOLVED" : inc.urgency === "high" ? ":rotating_light:" : ":warning:"} [${inc.id}] ${plain(inc.title, 200)} — ${plain(inc.service, 80)} (${inc.status}). ${impactLine}.${inc.urgency === "high" && affected.length ? ` ${Math.min(affected.length, input.maxNotices)} customer notice(s) drafted, awaiting approval.` : ""}`;
        const m = await providers.slack!.postMessage(input.warRoomChannel, text);
        return { ref: m.ts };
      },
    });

    actions.push({
      id: "pagerduty.timeline_note",
      kind: "pagerduty.timeline_note",
      provider: "pagerduty",
      agent: "customer-impact",
      gate: "auto",
      summary: { incidentId: inc.id },
      async execute({ providers }) {
        const n = await providers.pagerduty!.addNote(inc.id, `ACME comms: ${impactLine}. ${resolved ? "Resolution" : "Outage"} notices ${inc.urgency === "high" ? "drafted for approval" : "not sent (low urgency)"}.`);
        return { ref: n.id || inc.id };
      },
    });

    // Customers hear about high-urgency incidents only, and only after approval.
    if (inc.urgency === "high") {
      for (const c of affected.slice(0, input.maxNotices)) {
        const key = shortHash(inc.id, c.customerId);
        actions.push({
          id: `gmail.draft_customer_notice:${key}`,
          kind: "gmail.draft_customer_notice",
          provider: "gmail",
          agent: "account-owners",
          gate: "approval",
          summary: { to: c.email, incidentId: inc.id, kind: resolved ? "resolution" : "outage", ownerId: owners[c.email] ?? null, sent: false },
          async execute({ providers, runId }) {
            const d = await providers.gmail!.createDraft({
              to: c.email,
              subject: resolved ? `Resolved: ${plain(inc.service, 80)} service disruption` : `Service disruption: ${plain(inc.service, 80)}`,
              body: resolved
                ? `Hello${c.name ? ` ${plain(c.name, 80)}` : ""},\n\nThe disruption affecting ${plain(inc.service, 80)} has been resolved. We'll share a summary of the cause and follow-ups.\n\nACME Operations`
                : `Hello${c.name ? ` ${plain(c.name, 80)}` : ""},\n\nWe're investigating a disruption affecting ${plain(inc.service, 80)}. Our engineers are engaged and we'll update you as we learn more.\n\nACME Operations`,
              messageId: messageId(runId, `notice-${key}`),
            });
            return { ref: d.id };
          },
        });
      }
    }
    return actions;
  },

  output({ input }, results) {
    const impact = out<Impact>(results, "customer-impact");
    return {
      incidentId: input.incident.id,
      status: input.incident.status,
      impactKnown: !!impact,
      affectedCustomers: impact?.customers.length ?? null,
      noticesDrafted: input.incident.urgency === "high" ? Math.min(impact?.customers.length ?? 0, input.maxNotices) : 0,
    };
  },

  catalog: [
    { kind: "slack.war_room_update", provider: "slack", gate: "auto", description: "Post status and impact to the war-room channel" },
    { kind: "pagerduty.timeline_note", provider: "pagerduty", gate: "auto", description: "Record the comms status as a note on the incident" },
    { kind: "gmail.draft_customer_notice", provider: "gmail", gate: "approval", description: "Draft (not send) an outage or resolution notice per affected customer" },
  ],
};
