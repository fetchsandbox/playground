import { z } from "zod";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { Approvers, ChannelId, Email, out, plain, shortHash } from "./shared";

// Trade Compliance org · trade-compliance team.
// Trigger: a new order or quote. Every order is screened before it ships:
// restricted parties (Trade.gov Consolidated Screening List), item
// classification (ECCN / ITAR from the product record) and destination rules.
// The decision is fail-safe: anything that can't be confirmed clean is HELD.
// Releasing a hold always needs a compliance officer's approval.

const Input = z.object({
  orderRef: z.string().min(1).max(100).regex(/^[\w.:-]+$/),
  customerEmail: Email,
  /** Legal name of the buyer/consignee, screened against restricted-party lists. */
  partyName: z.string().min(1).max(200),
  shipToCountry: z.string().regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2, e.g. DE"),
  endUse: z.string().min(1).max(500),
  productIds: z.array(z.string().regex(/^prod_\w+$/)).min(1).max(50),
  complianceChannel: ChannelId,
  asanaWorkspace: z.string().min(1).default("acme-compliance"),
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

// Comprehensively sanctioned destinations (US EAR Country Group E:1/E:2 plus
// Russia and Belarus). Kept in code so a change is reviewed like any other.
export const EMBARGOED = new Set(["CU", "IR", "KP", "SY", "RU", "BY"]);
const MILITARY_END_USE = /\b(military|weapon|missile|munition|nuclear|defen[cs]e)\b/i;

interface Classification {
  items: { productId: string; name?: string; eccn?: string; itar: boolean; found: boolean }[];
}
interface Screening {
  hits: { name: string; source: string; score?: number }[];
}

export interface Decision {
  status: "clear" | "hold";
  reasons: string[];
}

/** Pure, fail-safe decision. Exported for tests. */
export function decide(input: Pick<Input, "shipToCountry" | "endUse">, cls: Classification | undefined, scr: Screening | undefined, screeningRan: boolean): Decision {
  const reasons: string[] = [];
  if (EMBARGOED.has(input.shipToCountry)) reasons.push(`embargoed destination ${input.shipToCountry}`);
  if (!screeningRan) reasons.push("restricted-party screening unavailable");
  else if (scr?.hits.length) reasons.push(`restricted-party match: ${scr.hits.map((h) => `${h.name} (${h.source})`).join("; ")}`);
  if (!cls) reasons.push("item classification unavailable");
  else {
    for (const i of cls.items) {
      if (!i.found) reasons.push(`${i.productId}: product not found`);
      else if (i.itar) reasons.push(`${i.productId}: ITAR-controlled, license required for export`);
      else if (!i.eccn) reasons.push(`${i.productId}: unclassified (no ECCN)`);
      else if (i.eccn !== "EAR99" && input.shipToCountry !== "US") reasons.push(`${i.productId}: ECCN ${i.eccn} needs a license determination for ${input.shipToCountry}`);
    }
  }
  if (MILITARY_END_USE.test(input.endUse)) reasons.push("military or WMD-related end use declared");
  return { status: reasons.length ? "hold" : "clear", reasons };
}

export const exportScreening: WorkflowDef<Input> = {
  id: "export-screening",
  title: "Export screening and order hold",
  org: "Trade Compliance",
  team: "trade-compliance",
  description:
    "Screen each order's parties, items and destination before it ships; hold anything not confirmed clean (fail-safe), open a compliance review and alert the channel. Releasing a hold requires approval.",
  input: Input,
  agents: [
    {
      name: "item-classification",
      needs: ["stripe"],
      async run({ input, providers }) {
        const items: Classification["items"] = [];
        for (const productId of [...new Set(input.productIds)].sort()) {
          try {
            const p = await providers.stripe!.getProduct(productId);
            const md = p.metadata ?? {};
            items.push({ productId, name: p.name, eccn: md.eccn?.trim().toUpperCase() || undefined, itar: md.itar === "true" || /^USML/i.test(md.usml ?? ""), found: true });
          } catch (err) {
            if ((err as { status?: number }).status !== 404) throw err;
            items.push({ productId, itar: false, found: false });
          }
        }
        return { summary: items.map((i) => `${i.productId}=${i.itar ? "ITAR" : (i.eccn ?? "unclassified")}`).join(", "), data: { items } satisfies Classification };
      },
    },
    {
      name: "party-screening",
      needs: ["screening"],
      async run({ input, providers }) {
        const hits = await providers.screening!.search(input.partyName, input.shipToCountry);
        return { summary: hits.length ? `${hits.length} possible match(es)` : "no matches", data: { hits } satisfies Screening };
      },
    },
    {
      name: "customer-record",
      needs: ["stripe"],
      async run({ input, providers }) {
        const c = await providers.stripe!.findCustomerByEmail(input.customerEmail);
        return { summary: c ? `customer ${c.id}${c.metadata?.export_hold ? " (already held)" : ""}` : "customer not in Stripe", data: { customerId: c?.id, existingHold: c?.metadata?.export_hold ?? null } };
      },
    },
  ],

  plan({ input }, results) {
    const d = decide(input, out<Classification>(results, "item-classification"), out<Screening>(results, "party-screening"), results.status["party-screening"] === "ok");
    const customerId = out<{ customerId?: string }>(results, "customer-record")?.customerId;
    const actions: PlannedAction<Input>[] = [];
    const reasonText = d.reasons.join("; ");

    if (d.status === "clear") {
      if (customerId) {
        actions.push({
          id: "stripe.record_clearance",
          kind: "stripe.record_clearance",
          provider: "stripe",
          agent: "item-classification",
          gate: "auto",
          summary: { customerId, orderRef: input.orderRef },
          async execute({ providers, runId }) {
            const c = await providers.stripe!.updateCustomerMetadata(customerId, { export_cleared_order: input.orderRef, export_cleared_run: runId });
            return { ref: c.id };
          },
        });
      }
      return actions;
    }

    if (customerId) {
      actions.push({
        id: "stripe.place_export_hold",
        kind: "stripe.place_export_hold",
        provider: "stripe",
        agent: "item-classification",
        gate: "auto",
        summary: { customerId, orderRef: input.orderRef, reasons: d.reasons },
        async execute({ providers, runId }) {
          const c = await providers.stripe!.updateCustomerMetadata(customerId, { export_hold: `${input.orderRef}: ${reasonText}`.slice(0, 480), export_hold_run: runId });
          return { ref: c.id };
        },
        async reconcile({ providers }, receipt) {
          const c = await providers.stripe!.getCustomer(receipt.ref);
          return c.metadata?.export_hold?.startsWith(input.orderRef) ? { status: "match" } : { status: "drift", detail: `export_hold is ${c.metadata?.export_hold || "cleared"}` };
        },
      });
    }
    actions.push({
      id: "asana.compliance_review",
      kind: "asana.compliance_review",
      provider: "asana",
      agent: "item-classification",
      gate: "auto",
      summary: { orderRef: input.orderRef, reasons: d.reasons },
      async execute({ providers }) {
        const t = await providers.asana!.createTask({
          name: `Export review: order ${input.orderRef} (${input.shipToCountry})`,
          notes: `Party: ${input.partyName} <${input.customerEmail}>\nDestination: ${input.shipToCountry}\nEnd use: ${input.endUse}\nProducts: ${input.productIds.join(", ")}\n\nHeld because: ${reasonText}`,
          workspace: input.asanaWorkspace,
        });
        return { ref: t.gid };
      },
    });
    actions.push({
      id: "slack.post_hold_alert",
      kind: "slack.post_hold_alert",
      provider: "slack",
      agent: "item-classification",
      gate: "auto",
      summary: { channel: input.complianceChannel, orderRef: input.orderRef },
      async execute({ providers }) {
        const m = await providers.slack!.postMessage(input.complianceChannel, `:no_entry: Export HOLD on order ${plain(input.orderRef, 100)} to ${input.shipToCountry} (${plain(input.partyName, 120)}).\n${d.reasons.map((r) => `• ${plain(r, 300)}`).join("\n")}\nRelease requires compliance approval.`);
        return { ref: m.ts, detail: { channel: m.channel } };
      },
    });
    // Embargoed destinations can't be released by this workflow, approval or not.
    if (customerId && !EMBARGOED.has(input.shipToCountry)) {
      actions.push({
        id: `stripe.release_export_hold:${shortHash(input.orderRef)}`,
        kind: "stripe.release_export_hold",
        provider: "stripe",
        agent: "item-classification",
        gate: "approval",
        summary: { customerId, orderRef: input.orderRef, overrides: d.reasons },
        async execute({ providers, runId }) {
          const c = await providers.stripe!.updateCustomerMetadata(customerId, { export_hold: "", export_released_order: input.orderRef, export_released_run: runId });
          return { ref: c.id };
        },
        async reconcile({ providers }, receipt) {
          const c = await providers.stripe!.getCustomer(receipt.ref);
          return !c.metadata?.export_hold && c.metadata?.export_released_order === input.orderRef ? { status: "match" } : { status: "drift", detail: `export_hold is ${c.metadata?.export_hold || "cleared"}` };
        },
      });
    }
    return actions;
  },

  output({ input }, results) {
    const ran = results.status["party-screening"] === "ok";
    const d = decide(input, out<Classification>(results, "item-classification"), out<Screening>(results, "party-screening"), ran);
    return { orderRef: input.orderRef, decision: d.status, reasons: d.reasons, screeningRan: ran, embargoed: EMBARGOED.has(input.shipToCountry) };
  },

  catalog: [
    { kind: "stripe.place_export_hold", provider: "stripe", gate: "auto", description: "Hold the account's orders (Stripe customer metadata export_hold)" },
    { kind: "asana.compliance_review", provider: "asana", gate: "auto", description: "Open a compliance review task with the hold reasons" },
    { kind: "slack.post_hold_alert", provider: "slack", gate: "auto", description: "Alert the compliance channel" },
    { kind: "stripe.release_export_hold", provider: "stripe", gate: "approval", description: "Release the hold (never for embargoed destinations)" },
    { kind: "stripe.record_clearance", provider: "stripe", gate: "auto", description: "Record a clean screening on the account" },
  ],
};
