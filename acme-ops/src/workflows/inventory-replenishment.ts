import { z } from "zod";
import { SkipAction } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { ChannelId, Email, messageId, money, out } from "./shared";

// Operations · supply-chain.
// Trigger: the nightly replenishment run for one warehouse. For every planned
// SKU: 28-day sales velocity from Shopify orders, units available at the
// location (Shopify inventory levels) and units already on open purchase orders
// (NetSuite). Below the reorder point (velocity × (lead time + safety days)),
// the order quantity covers lead time + review period + safety stock, rounded
// up to the supplier's MOQ and case pack. Lines are grouped into one purchase
// order per supplier per day (idempotent by external id); a PO over the auto
// limit waits for a buyer. Then, durably:
//   - the PO goes to the supplier as an email draft;
//   - two days after the expected receipt date the PO is re-read: anything not
//     fully received is escalated as late;
//   - SKUs that will stock out before a new PO can arrive are flagged to
//     expedite at once.
// Missing velocity, stock or open-PO data blocks the affected SKUs only.

export const POLICY = { velocityDays: 28, reviewDays: 14, autoPoMax: 10_000_00, lateGraceDays: 2, maxSkus: 1000 } as const;
const DAY = 86_400_000;

const Item = z.object({
  sku: z.string().min(1).max(64),
  variantId: z.string().regex(/^\d+$/),
  netsuiteItemId: z.string().regex(/^\d+$/),
  supplierId: z.string().regex(/^\d+$/),
  /** Minor units per unit. */
  unitCost: z.number().int().positive(),
  leadTimeDays: z.number().int().min(1).max(180),
  safetyDays: z.number().int().min(0).max(90),
  moq: z.number().int().min(1).default(1),
  casePack: z.number().int().min(1).default(1),
});
const Input = z.object({
  runId: z.string().regex(/^REPL-[\w-]{3,40}$/, "run id like REPL-2026-10-22-DC1"),
  locationId: z.string().regex(/^\d+$/),
  department: z.string().regex(/^\d+$/),
  items: z.array(Item).min(1).max(POLICY.maxSkus),
  suppliers: z.record(z.string(), z.object({ name: z.string().min(1), email: Email })),
  opsChannel: ChannelId,
  approvers: z.array(z.string()).min(1),
});
type Input = z.infer<typeof Input>;
type ItemT = z.infer<typeof Item>;

export interface Position {
  sku: string;
  velocity: number | null;
  available: number | null;
  incoming: number | null;
}
export interface Need {
  sku: string;
  qty: number;
  reorderPoint: number;
  stockoutBeforeArrival: boolean;
  problem: string | null;
}

/** Pure reorder decision for one SKU. */
export function need(item: ItemT, p: Position): Need {
  const base = { sku: item.sku, qty: 0, reorderPoint: 0, stockoutBeforeArrival: false };
  if (p.velocity === null || p.available === null || p.incoming === null) return { ...base, problem: p.velocity === null ? "sales velocity unavailable" : p.available === null ? "stock level unavailable" : "open purchase orders unavailable" };
  const reorderPoint = Math.ceil(p.velocity * (item.leadTimeDays + item.safetyDays));
  const position = p.available + p.incoming;
  const stockoutBeforeArrival = p.velocity > 0 && p.available < p.velocity * item.leadTimeDays && p.incoming === 0;
  if (position >= reorderPoint) return { ...base, reorderPoint, stockoutBeforeArrival, problem: null };
  const target = Math.ceil(p.velocity * (item.leadTimeDays + POLICY.reviewDays + item.safetyDays));
  let qty = Math.max(item.moq, target - position);
  qty = Math.ceil(qty / item.casePack) * item.casePack;
  return { sku: item.sku, qty, reorderPoint, stockoutBeforeArrival, problem: null };
}

export const inventoryReplenishment: WorkflowDef<Input> = {
  id: "inventory-replenishment",
  title: "Inventory replenishment",
  org: "Operations",
  team: "supply-chain",
  description:
    "Compute each SKU's reorder need from Shopify sales velocity, available stock and open NetSuite POs; raise one PO per supplier per day (approval over the limit), email it to the supplier as a draft, escalate POs not received two days after their due date, and flag SKUs that will stock out before replenishment arrives.",
  input: Input,
  audit: true,
  tickEvery: "rate(1 hour)",
  agents: [
    {
      name: "velocity",
      needs: ["shopify"],
      async run({ input, providers, startedAt }) {
        const since = new Date(startedAt.getTime() - POLICY.velocityDays * DAY).toISOString();
        const orders = (await providers.shopify!.ordersSince(since)).filter((o) => !o.cancelled_at);
        const sold: Record<string, number> = {};
        for (const o of orders) for (const l of o.line_items ?? []) if (l.variant_id != null) sold[String(l.variant_id)] = (sold[String(l.variant_id)] ?? 0) + (l.quantity ?? 0);
        const v = Object.fromEntries(input.items.map((i) => [i.sku, (sold[i.variantId] ?? 0) / POLICY.velocityDays]));
        return { summary: `${orders.length} order(s) in ${POLICY.velocityDays} days`, data: v };
      },
    },
    {
      name: "stock",
      needs: ["shopify"],
      async run({ input, providers }) {
        const shop = providers.shopify!;
        const itemIds: Record<string, string> = {};
        for (const i of input.items) itemIds[i.sku] = String((await shop.getVariant(i.variantId)).inventory_item_id);
        const levels = await shop.available(Object.values(itemIds), input.locationId);
        const data = Object.fromEntries(input.items.map((i) => [i.sku, itemIds[i.sku]! in levels ? levels[itemIds[i.sku]!]! : null]));
        return { summary: `stock for ${Object.values(data).filter((x) => x !== null).length}/${input.items.length} SKU(s)`, data };
      },
    },
    {
      name: "open-pos",
      needs: ["netsuite"],
      async run({ input, providers }) {
        const incoming = await providers.netsuite!.incomingByItem(input.items.map((i) => i.netsuiteItemId));
        return { summary: `${Object.keys(incoming).length} SKU(s) with open POs`, data: Object.fromEntries(input.items.map((i) => [i.sku, incoming[i.netsuiteItemId] ?? 0])) };
      },
    },
  ],

  compose: {
    name: "plan",
    async run({ input }, results) {
      const v = out<Record<string, number>>(results, "velocity");
      const s = out<Record<string, number | null>>(results, "stock");
      const o = out<Record<string, number>>(results, "open-pos");
      const needs = input.items.map((i) => need(i, { sku: i.sku, velocity: v ? (v[i.sku] ?? 0) : null, available: s ? (s[i.sku] ?? null) : null, incoming: o ? (o[i.sku] ?? 0) : null }));
      return { summary: `${needs.filter((n) => n.qty > 0).length} SKU(s) to reorder, ${needs.filter((n) => n.stockoutBeforeArrival).length} at stockout risk, ${needs.filter((n) => n.problem).length} blocked`, data: needs };
    },
  },

  plan({ input, startedAt }, results) {
    const needs = out<Need[]>(results, "plan") ?? [];
    const bySupplier = new Map<string, { item: ItemT; n: Need }[]>();
    for (const n of needs.filter((x) => x.qty > 0)) {
      const item = input.items.find((i) => i.sku === n.sku)!;
      bySupplier.set(item.supplierId, [...(bySupplier.get(item.supplierId) ?? []), { item, n }]);
    }
    const day = startedAt.toISOString().slice(0, 10);
    const actions: PlannedAction<Input>[] = [];
    for (const [supplierId, lines] of bySupplier) {
      const supplier = input.suppliers[supplierId];
      const total = lines.reduce((t, l) => t + l.n.qty * l.item.unitCost, 0);
      const lead = Math.max(...lines.map((l) => l.item.leadTimeDays));
      const due = new Date(startedAt.getTime() + lead * DAY).toISOString().slice(0, 10);
      const externalId = `REPL-${day}-${supplierId}`;
      const po = `netsuite.create_po:${supplierId}`;
      actions.push({
        id: po,
        kind: "netsuite.create_po",
        provider: "netsuite",
        agent: "plan",
        gate: total > POLICY.autoPoMax ? "approval" : "auto",
        summary: { supplier: supplier?.name ?? supplierId, lines: lines.map((l) => `${l.item.sku}×${l.n.qty}`), total: money(total), due },
        async execute({ providers }) {
          const ns = providers.netsuite!;
          const existing = await ns.findPurchaseOrder(externalId);
          if (existing) return { ref: existing.id, detail: { reused: true, tranId: existing.tranId } };
          const created = await ns.createPurchaseOrder({ externalId, vendorId: supplierId, department: input.department, memo: `${input.runId} replenishment`, dueDate: due, items: lines.map((l) => ({ item: l.item.netsuiteItemId, quantity: l.n.qty, rate: l.item.unitCost / 100 })) });
          return { ref: created.id, detail: { tranId: (await ns.findPurchaseOrder(externalId))?.tranId } };
        },
      });
      if (supplier) {
        actions.push({
          id: `gmail.po_to_supplier:${supplierId}`,
          kind: "gmail.po_to_supplier",
          provider: "gmail",
          agent: "plan",
          gate: "auto",
          summary: { supplier: supplier.name, sent: false },
          requires: [po],
          async execute({ providers, applied, runId }) {
            const tran = String(applied[po]!.detail?.tranId ?? applied[po]!.ref);
            const d = await providers.gmail!.createDraft({
              to: supplier.email,
              subject: `Purchase order ${tran} from ACME`,
              body: `Hello ${supplier.name},\n\nPlease confirm purchase order ${tran}, needed by ${due}:\n${lines.map((l) => `- ${l.item.sku}: ${l.n.qty} units at ${money(l.item.unitCost)}`).join("\n")}\n\nTotal ${money(total)}.\n\nACME Purchasing`,
              messageId: messageId(runId, `po-${supplierId}`),
            });
            return { ref: d.id };
          },
        });
      }
      actions.push({
        id: `receiving.late_check:${supplierId}`,
        kind: "receiving.late_check",
        provider: "netsuite",
        agent: "plan",
        gate: "auto",
        summary: { supplier: supplier?.name ?? supplierId, due, graceDays: POLICY.lateGraceDays },
        requires: [po],
        waitUntil: new Date(Date.parse(`${due}T00:00:00Z`) + POLICY.lateGraceDays * DAY).toISOString(),
        async execute({ providers, applied }) {
          const p = await providers.netsuite!.getPurchaseOrder(applied[po]!.ref);
          const short = (p.item?.items ?? []).filter((l) => (l.quantityReceived ?? 0) < l.quantity);
          if (!short.length) throw new SkipAction("fully received");
          const text = `:truck: PO ${p.tranId ?? p.id} from ${supplier?.name ?? supplierId} was due ${due} and is ${short.length} line(s) short (${short.map((l) => `item ${l.item.id}: ${l.quantityReceived ?? 0}/${l.quantity}`).join(", ")}).`;
          return { ref: (await providers.slack!.postMessage(input.opsChannel, text)).ts, detail: { shortLines: short.length } };
        },
      });
    }
    const risk = needs.filter((n) => n.stockoutBeforeArrival);
    const blocked = needs.filter((n) => n.problem);
    actions.push({
      id: "slack.post_replenishment",
      kind: "slack.post_replenishment",
      provider: "slack",
      agent: "plan",
      gate: "auto",
      summary: { pos: bySupplier.size, stockoutRisk: risk.length, blocked: blocked.length },
      async execute({ providers }) {
        const text = [
          `:package: ${input.runId}: ${bySupplier.size} purchase order(s) for ${needs.filter((n) => n.qty > 0).length} SKU(s).`,
          risk.length ? `:rotating_light: Will stock out before replenishment arrives, expedite: ${risk.map((r) => r.sku).join(", ")}` : "",
          blocked.length ? `Not planned: ${blocked.map((b) => `${b.sku} (${b.problem})`).join("; ")}` : "",
        ].filter(Boolean);
        return { ref: (await providers.slack!.postMessage(input.opsChannel, text.join("\n"))).ts };
      },
    });
    return actions;
  },

  output(_ctx, results) {
    const needs = out<Need[]>(results, "plan");
    if (!needs) return { mode: "blocked" };
    return { mode: "replenish", reorder: needs.filter((n) => n.qty > 0).length, units: needs.reduce((t, n) => t + n.qty, 0), stockoutRisk: needs.filter((n) => n.stockoutBeforeArrival).length, blocked: needs.filter((n) => n.problem).length };
  },

  catalog: [
    { kind: "netsuite.create_po", provider: "netsuite", gate: "auto", description: "One PO per supplier per day; approval over 10,000" },
    { kind: "gmail.po_to_supplier", provider: "gmail", gate: "auto", description: "PO to the supplier (draft)" },
    { kind: "receiving.late_check", provider: "netsuite", gate: "auto", description: "Escalate lines not received two days after the due date" },
    { kind: "slack.post_replenishment", provider: "slack", gate: "auto", description: "Summary, stockout risks and SKUs that couldn't be planned" },
  ],
};
