import { z } from "zod";
import { SkipAction } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import type { Providers } from "../providers";
import { ChannelId, out } from "./shared";

// Operations · fulfillment-ops (with support).
// Trigger: an EasyPost tracker update (webhook) for a Shopify order's shipment.
// The tracker's scan history decides the case:
//   delivered / on track → nothing;
//   delayed (past the estimate), stuck (no scan for 3 days) or a carrier
//   exception → the customer hears from us first: one Zendesk ticket per
//   shipment with a public apology and the latest scan, then a durable
//   48-hour re-check: delivered by then → the ticket is solved; still not →
//   the shipment is treated as lost and a free replacement is sent;
//   lost (no scan for 7 days) or returned to sender → replacement at once.
// Replacements are a 100% discounted Shopify draft order completed into an
// order, once per shipment (the original order is tagged); over 200 they wait
// for a fulfillment lead. Re-delivered webhooks never open a second ticket.

export const POLICY = { stuckDays: 3, lostDays: 7, recheckHours: 48, autoReplaceMax: 200_00 } as const;
const DAY = 86_400_000;

const Input = z.object({
  eventId: z.string().regex(/^evt_[\w-]{6,64}$/),
  trackerId: z.string().regex(/^trk_\w+$/),
  orderId: z.string().regex(/^\d+$/),
  opsChannel: ChannelId,
  approvers: z.array(z.string()).min(1),
});
type Input = z.infer<typeof Input>;

export type Case = "delivered" | "on_track" | "delayed" | "stuck" | "exception" | "lost" | "returned";
export interface Shipment {
  case: Case;
  carrier: string;
  trackingCode: string;
  lastScan: string | null;
  lastMessage: string | null;
}
interface Order {
  name: string;
  email: string | null;
  valueMinor: number;
  lines: { variant_id: string | number; quantity: number }[];
  replaced: boolean;
}

/** Pure classification from tracker status, scans and estimate. */
export function classify(t: { status: string; est_delivery_date?: string | null; tracking_details?: { datetime: string; status: string; message?: string | null }[] }, now: number): Case {
  if (t.status === "delivered") return "delivered";
  if (t.status === "return_to_sender") return "returned";
  const scans = [...(t.tracking_details ?? [])].sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
  const last = scans.at(-1);
  const idle = last ? (now - Date.parse(last.datetime)) / DAY : Infinity;
  if (idle >= POLICY.lostDays) return "lost";
  if (["failure", "error", "cancelled"].includes(t.status)) return "exception";
  if (idle >= POLICY.stuckDays) return "stuck";
  if (t.est_delivery_date && Date.parse(t.est_delivery_date) < now) return "delayed";
  return "on_track";
}

const ticketKey = (trackerId: string) => `shipment-${trackerId}`;

async function replace(providers: Providers, input: Input, order: Order, why: string) {
  const shop = providers.shopify!;
  const cur = await shop.getOrder(input.orderId);
  if ((cur.tags ?? "").includes(`replaced-${input.trackerId}`)) throw new SkipAction("already replaced");
  const r = await shop.createReplacement({ lineItems: order.lines, email: order.email, note: `Replacement for ${order.name} (${why}, tracker ${input.trackerId})`, tags: ["replacement", `replaces-${input.orderId}`] });
  await shop.addTags(input.orderId, [`replaced-${input.trackerId}`]);
  return { ref: String(r.orderId ?? r.draftId), detail: { draftId: r.draftId } };
}

export const deliveryException: WorkflowDef<Input> = {
  id: "delivery-exception",
  title: "Delivery exception handling",
  org: "Operations",
  team: "fulfillment-ops",
  description:
    "Classify a shipment from its EasyPost scans; tell the customer first through one Zendesk ticket when it's delayed, stuck or in exception, re-check after 48 hours and either solve the ticket or send a free Shopify replacement; lost or returned shipments are replaced at once, over 200 with a lead's approval.",
  input: Input,
  audit: true,
  tickEvery: "rate(15 minutes)",
  agents: [
    {
      name: "tracking",
      needs: ["easypost"],
      async run({ input, providers, startedAt }) {
        const t = await providers.easypost!.getTracker(input.trackerId);
        const scans = [...(t.tracking_details ?? [])].sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
        const data: Shipment = { case: classify(t, startedAt.getTime()), carrier: t.carrier ?? "carrier", trackingCode: t.tracking_code, lastScan: scans.at(-1)?.datetime ?? null, lastMessage: scans.at(-1)?.message ?? null };
        return { summary: `${data.carrier} ${data.trackingCode}: ${data.case}`, data };
      },
    },
    {
      name: "order",
      needs: ["shopify"],
      async run({ input, providers }) {
        const o = await providers.shopify!.getOrder(input.orderId);
        const data: Order = { name: o.name ?? `#${o.id}`, email: o.email ?? null, valueMinor: Math.round(Number(o.total_price ?? 0) * 100), lines: (o.line_items ?? []).filter((l) => l.variant_id != null).map((l) => ({ variant_id: l.variant_id!, quantity: l.quantity ?? 1 })), replaced: (o.tags ?? "").includes(`replaced-${input.trackerId}`) };
        return { summary: `${data.name}: ${data.lines.length} line(s)${data.replaced ? ", already replaced" : ""}`, data };
      },
    },
  ],

  plan({ input }, results) {
    const s = out<Shipment>(results, "tracking");
    const o = out<Order>(results, "order");
    if (!s || !o) {
      return [
        {
          id: "slack.post_unreadable",
          kind: "slack.post_unreadable",
          provider: "slack",
          agent: "tracking",
          gate: "auto",
          summary: { tracker: input.trackerId },
          async execute({ providers }) {
            return { ref: (await providers.slack!.postMessage(input.opsChannel, `:warning: Tracker ${input.trackerId} (order ${input.orderId}) could not be ${s ? "matched to its order" : "read"}; no customer action taken.`)).ts };
          },
        },
      ];
    }
    if (["delivered", "on_track"].includes(s.case) || o.replaced) return [];
    const actions: PlannedAction<Input>[] = [];
    const notice = `zendesk.proactive_notice:${input.trackerId}`;
    const gate = o.valueMinor > POLICY.autoReplaceMax ? "approval" : "auto";
    if (o.email) {
      actions.push({
        id: notice,
        kind: "zendesk.proactive_notice",
        provider: "zendesk",
        agent: "tracking",
        gate: "auto",
        summary: { order: o.name, case: s.case },
        async execute({ providers }) {
          const zd = providers.zendesk!;
          const existing = (await zd.findTicketsByExternalId(ticketKey(input.trackerId)))[0];
          if (existing) return { ref: String(existing.id), detail: { reused: true } };
          const t = await zd.createTicket({ subject: `Your order ${o.name} is delayed`, body: `Proactive: ${s.carrier} ${s.trackingCode} is ${s.case}; last scan ${s.lastScan ?? "none"} ${s.lastMessage ?? ""}.`, requester: { email: o.email! }, tags: ["delivery_exception", `case_${s.case}`], externalId: ticketKey(input.trackerId) });
          const lost = s.case === "lost" || s.case === "returned";
          await zd.addComment(t.id, { body: lost ? `We're sorry: your order ${o.name} won't arrive as planned (${s.carrier} ${s.trackingCode}). We're sending a replacement at no cost and will email its tracking number.` : `We're sorry: your order ${o.name} is running late with ${s.carrier} (${s.trackingCode}). We're watching it and will update you within ${POLICY.recheckHours} hours.`, public: true }, "pending");
          return { ref: String(t.id) };
        },
      });
    }
    if (s.case === "lost" || s.case === "returned") {
      actions.push({
        id: `shopify.replacement:${input.trackerId}`,
        kind: "shopify.replacement",
        provider: "shopify",
        agent: "order",
        gate,
        summary: { order: o.name, reason: s.case, value: o.valueMinor },
        async execute({ providers }) {
          return replace(providers, input, o, s.case);
        },
      });
    } else {
      const recheck = `easypost.recheck:${input.trackerId}`;
      actions.push({
        id: recheck,
        kind: "easypost.recheck",
        provider: "easypost",
        agent: "tracking",
        gate: "auto",
        summary: { tracker: input.trackerId, afterHours: POLICY.recheckHours },
        ...(o.email ? { after: [notice], delayAfter: { action: notice, ms: POLICY.recheckHours * 3_600_000 } } : {}),
        async execute({ providers, applied }) {
          const t = await providers.easypost!.getTracker(input.trackerId);
          const ticket = applied[notice]?.ref;
          if (t.status === "delivered") {
            if (ticket) await providers.zendesk!.addComment(ticket, { body: `Good news: ${s.carrier} shows order ${o.name} delivered. Reply if anything is missing.`, public: true }, "solved");
            throw new SkipAction("delivered");
          }
          return { ref: t.id, detail: { status: t.status } };
        },
      });
      actions.push({
        id: `shopify.replacement:${input.trackerId}`,
        kind: "shopify.replacement",
        provider: "shopify",
        agent: "order",
        gate,
        summary: { order: o.name, reason: `still ${s.case} after ${POLICY.recheckHours}h`, value: o.valueMinor },
        requires: [recheck],
        async execute({ providers, applied }) {
          const r = await replace(providers, input, o, `not delivered ${POLICY.recheckHours}h after ${s.case}`);
          const ticket = applied[notice]?.ref;
          if (ticket) await providers.zendesk!.addComment(ticket, { body: `Your order still hasn't moved, so we've sent a replacement at no cost. You'll get its tracking number by email.`, public: true }, "pending");
          return r;
        },
      });
    }
    return actions;
  },

  output(_ctx, results) {
    const s = out<Shipment>(results, "tracking");
    const o = out<Order>(results, "order");
    if (!s || !o) return { mode: "blocked" };
    return { mode: s.case, order: o.name, replaced: o.replaced };
  },

  catalog: [
    { kind: "zendesk.proactive_notice", provider: "zendesk", gate: "auto", description: "One ticket per shipment with a public apology" },
    { kind: "easypost.recheck", provider: "easypost", gate: "auto", description: "Re-read the tracker 48 hours later; solve the ticket if delivered" },
    { kind: "shopify.replacement", provider: "shopify", gate: "auto", description: "Free replacement once per shipment; approval over 200" },
    { kind: "slack.post_unreadable", provider: "slack", gate: "auto", description: "Tracker or order unreadable: nothing done" },
  ],
};
