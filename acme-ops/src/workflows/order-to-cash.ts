import { z } from "zod";
import { FatalError } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import type { ShopifyOrder } from "../providers/commerce";
import { Approvers, ChannelId, money, out } from "./shared";

// Operations · fulfillment-ops.
// Trigger: a storefront order (Shopify) is ready to ship. The order is booked
// as a sales order in the ERP (NetSuite) first, then a label is bought from
// the carrier aggregator (EasyPost), then Shopify gets the fulfillment with
// tracking so the customer is notified. Nothing ships without a sales order,
// an unpaid or cancelled order never ships, and an expensive label or a large
// order waits for a person.

export const POLICY = {
  /** Orders above this are booked only with approval. */
  autoBookMaxMinor: 1_000_000,
  /** Labels costing more than this are bought only with approval. */
  autoLabelMaxMinor: 5_000,
  /** Where parcels ship from. */
  warehouse: { name: "ACME Fulfillment", street1: "100 Dock Rd", city: "Reno", state: "NV", zip: "89502", country: "US" },
  /** Parcel weight per unit, ounces. */
  ouncesPerUnit: 8,
} as const;

const Input = z.object({
  /** Shopify order id. */
  orderId: z.string().regex(/^[\w-]{3,64}$/),
  opsChannel: ChannelId,
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

export interface Order {
  orderId: string;
  email: string | null;
  financialStatus: string | null;
  cancelled: boolean;
  fulfilled: boolean;
  currency: string;
  totalMinor: number;
  lines: { sku: string; quantity: number; rateMinor: number }[];
  address: { name?: string; street1?: string; city?: string; state?: string; zip?: string; country?: string } | null;
}
export interface Erp {
  salesOrderId: string | null;
}
export interface Decision {
  mode: "ship" | "already_shipped" | "hold" | "nothing" | "blocked";
  reason: string;
  bookGate: "auto" | "approval";
  needsSalesOrder: boolean;
}

const toMinor = (s: string | undefined) => Math.round(Number(s ?? "0") * 100);

export function orderFrom(id: string, o: ShopifyOrder, fulfillments: number): Order {
  const lines = (o.line_items ?? []).map((l) => ({ sku: l.sku ?? "", quantity: l.quantity ?? 0, rateMinor: toMinor(l.price) }));
  const a = o.shipping_address;
  return {
    orderId: id,
    email: o.email ?? null,
    financialStatus: o.financial_status ?? null,
    cancelled: !!o.cancelled_at,
    fulfilled: o.fulfillment_status === "fulfilled" || fulfillments > 0,
    currency: (o.currency ?? "USD").toLowerCase(),
    // Shopify's own total when present; otherwise the lines (never a number from outside the order).
    totalMinor: o.total_price ? toMinor(o.total_price) : lines.reduce((s, l) => s + l.rateMinor * l.quantity, 0),
    lines,
    address: a ? { name: a.name, street1: a.address1, city: a.city, state: a.province_code ?? a.province, zip: a.zip, country: a.country_code ?? a.country } : null,
  };
}

/** What happens to the order. Pure. */
export function decide(order: Order | undefined, erp: Erp | undefined, erpStatus: string, carrierConnected: boolean): Decision {
  const base = { bookGate: "auto" as const, needsSalesOrder: false };
  if (!order) return { ...base, mode: "blocked", reason: "order could not be read" };
  if (order.cancelled) return { ...base, mode: "nothing", reason: "order is cancelled" };
  if (order.fulfilled) return { ...base, mode: "already_shipped", reason: "order already has a fulfillment" };
  if (order.financialStatus !== "paid") return { ...base, mode: "hold", reason: `order is ${order.financialStatus ?? "not marked paid"}` };
  if (!order.lines.length || order.lines.some((l) => !l.sku || l.quantity < 1)) return { ...base, mode: "hold", reason: "order lines lack SKUs or quantities" };
  const a = order.address;
  if (!a?.street1 || !a.city || !a.zip || !a.country) return { ...base, mode: "hold", reason: "shipping address is incomplete" };
  // Fail closed: no sales order, no shipment.
  if (!erp) return { ...base, mode: "blocked", reason: erpStatus === "skipped" ? "ERP not connected" : "ERP could not be read" };
  if (!carrierConnected) return { ...base, mode: "blocked", reason: "carrier not connected" };
  return { mode: "ship", reason: "paid, complete, not shipped", bookGate: order.totalMinor > POLICY.autoBookMaxMinor ? "approval" : "auto", needsSalesOrder: !erp.salesOrderId };
}

export const orderToCash: WorkflowDef<Input> = {
  id: "order-to-cash",
  title: "Order to cash with shipping",
  org: "Operations",
  team: "fulfillment-ops",
  description:
    "Ship a paid Shopify order: book it as a NetSuite sales order, buy the cheapest EasyPost label under a cost limit, then add the fulfillment with tracking to Shopify. Nothing ships without a sales order; unpaid, cancelled or incomplete orders are held; large orders and expensive labels need approval.",
  input: Input,
  agents: [
    {
      name: "order-check",
      needs: ["shopify"],
      async run({ input, providers }) {
        const shop = providers.shopify!;
        const o = await shop.getOrder(input.orderId);
        if (!o) throw new FatalError(`order ${input.orderId} not found`);
        const fulfillments = await shop.listFulfillments(input.orderId);
        const data = orderFrom(input.orderId, o, fulfillments.length);
        return { summary: `${data.financialStatus ?? "?"}, ${data.lines.length} line(s), ${money(data.totalMinor, data.currency)}${data.fulfilled ? ", fulfilled" : ""}`, data };
      },
    },
    {
      name: "erp-check",
      needs: ["netsuite"],
      async run({ input, providers }) {
        const so = await providers.netsuite!.findSalesOrder(`shopify-${input.orderId}`);
        return { summary: so ? `sales order ${so.id}` : "no sales order yet", data: { salesOrderId: so?.id ?? null } satisfies Erp };
      },
    },
  ],

  compose: {
    name: "fulfillment-decision",
    async run({ providers }, results) {
      const d = decide(out<Order>(results, "order-check"), out<Erp>(results, "erp-check"), results.status["erp-check"] ?? "missing", !!providers.easypost);
      return { summary: `${d.mode}: ${d.reason}`, data: d };
    },
  },

  plan({ input }, results) {
    const d = out<Decision>(results, "fulfillment-decision");
    const order = out<Order>(results, "order-check");
    if (!d) return [];
    const actions: PlannedAction<Input>[] = [];
    if (d.mode === "ship" && order) {
      const externalId = `shopify-${input.orderId}`;
      actions.push({
        id: `netsuite.book_sales_order:${input.orderId}`,
        kind: "netsuite.book_sales_order",
        provider: "netsuite",
        agent: "fulfillment-decision",
        gate: d.bookGate,
        summary: { order: input.orderId, total: money(order.totalMinor, order.currency), lines: order.lines.length },
        async execute({ providers }) {
          if (!providers.netsuite) throw new FatalError("ERP not connected");
          const existing = await providers.netsuite.findSalesOrder(externalId);
          if (existing) return { ref: existing.id, detail: { reused: true } };
          const so = await providers.netsuite.createSalesOrder({ externalId, customerEmail: order.email ?? "", currency: order.currency, lines: order.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, rate: l.rateMinor / 100 })), memo: `Shopify order ${input.orderId}` });
          return { ref: so.id };
        },
        async reconcile({ providers }, receipt) {
          const so = await providers.netsuite!.getSalesOrder(receipt.ref);
          return so.externalId === externalId ? { status: "match" } : { status: "drift", detail: `sales order external id ${so.externalId}` };
        },
      });
      actions.push({
        id: `easypost.buy_label:${input.orderId}`,
        kind: "easypost.buy_label",
        provider: "easypost",
        agent: "fulfillment-decision",
        gate: d.bookGate,
        summary: { order: input.orderId, maxAuto: money(POLICY.autoLabelMaxMinor, "usd") },
        async execute({ providers, applied }) {
          if (!applied[`netsuite.book_sales_order:${input.orderId}`]) throw new FatalError("no sales order: nothing ships");
          if (!providers.easypost) throw new FatalError("carrier not connected");
          const units = order.lines.reduce((s, l) => s + l.quantity, 0);
          const a = order.address!;
          const shipment = await providers.easypost.createShipment({ reference: input.orderId, to: { name: a.name, street1: a.street1, city: a.city, state: a.state, zip: a.zip, country: a.country }, from: { ...POLICY.warehouse }, parcel: { weight: Math.max(1, units * POLICY.ouncesPerUnit) } });
          const cheapest = [...shipment.rates].filter((r) => r.currency?.toUpperCase() === "USD").sort((x, y) => Number(x.rate) - Number(y.rate))[0];
          if (!cheapest) throw new FatalError("carrier returned no USD rate");
          // The cost limit is checked on the real quote, at write time.
          if (Math.round(Number(cheapest.rate) * 100) > POLICY.autoLabelMaxMinor && d.bookGate === "auto") throw new FatalError(`cheapest label ${cheapest.rate} USD is above the automatic limit`);
          const bought = await providers.easypost.buy(shipment.id, cheapest.id, `label-${input.orderId}`);
          if (!bought.tracking_code) throw new FatalError("label bought without a tracking code");
          return { ref: bought.id, detail: { tracking: bought.tracking_code, carrier: cheapest.carrier, rate: cheapest.rate } };
        },
        async reconcile({ providers }, receipt) {
          const s = await providers.easypost!.getShipment(receipt.ref);
          return s.tracking_code ? { status: "match" } : { status: "drift", detail: "shipment has no tracking code" };
        },
      });
      actions.push({
        id: `shopify.fulfill:${input.orderId}`,
        kind: "shopify.fulfill",
        provider: "shopify",
        agent: "fulfillment-decision",
        gate: d.bookGate,
        summary: { order: input.orderId, notifiesCustomer: true },
        async execute({ providers, applied }) {
          const label = applied[`easypost.buy_label:${input.orderId}`];
          if (!label) throw new FatalError("no label: nothing to fulfil");
          // Another run may have fulfilled it since the scan.
          if ((await providers.shopify!.listFulfillments(input.orderId)).length) return { ref: input.orderId, detail: { reused: true } };
          const f = await providers.shopify!.createFulfillment(input.orderId, { trackingNumber: String(label.detail!.tracking), trackingCompany: String(label.detail!.carrier) });
          return { ref: String(f.id), detail: { tracking: label.detail!.tracking } };
        },
      });
    }
    const text = `${d.mode === "ship" ? ":package:" : d.mode === "blocked" ? ":rotating_light:" : d.mode === "hold" ? ":pause_button:" : ":white_check_mark:"} Order ${input.orderId}: ${d.mode} (${d.reason})${order ? `, ${money(order.totalMinor, order.currency)}` : ""}${d.bookGate === "approval" && d.mode === "ship" ? ", needs approval" : ""}.`;
    actions.push({
      id: "slack.post_order",
      kind: "slack.post_order",
      provider: "slack",
      agent: "fulfillment-decision",
      gate: "auto",
      summary: { channel: input.opsChannel, mode: d.mode },
      async execute({ providers }) {
        const m = await providers.slack!.postMessage(input.opsChannel, text);
        return { ref: m.ts };
      },
    });
    return actions;
  },

  output(_ctx, results) {
    const d = out<Decision>(results, "fulfillment-decision");
    if (!d) return { mode: "not decided" };
    return { mode: d.mode, reason: d.reason, bookGate: d.bookGate };
  },

  catalog: [
    { kind: "netsuite.book_sales_order", provider: "netsuite", gate: "auto", description: "Book the NetSuite sales order (external id shopify-<order>); approval above $10,000" },
    { kind: "easypost.buy_label", provider: "easypost", gate: "auto", description: "Buy the cheapest USD label under $50, only after the sales order exists" },
    { kind: "shopify.fulfill", provider: "shopify", gate: "auto", description: "Add the fulfillment with tracking to the Shopify order (notifies the customer)" },
    { kind: "slack.post_order", provider: "slack", gate: "auto", description: "Order outcome in the operations channel" },
  ],
};
