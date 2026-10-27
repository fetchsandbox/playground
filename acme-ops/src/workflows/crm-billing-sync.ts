import { z } from "zod";
import { FatalError, SkipAction } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import type { StripeSubscription } from "../providers/stripe";
import { Approvers, ChannelId, out } from "./shared";

// RevOps · revops-systems.
// Trigger: the hourly CRM ↔ billing sync for one customer segment.
// Billing (Stripe) owns plan, MRR and billing status; the CRM (HubSpot) owns
// everything else. Each billing customer is matched to its HubSpot contact by
// link (acme_stripe_customer_id) or email, then the billing-owned fields are
// written. Guards against the failures that make sync jobs dangerous:
//   - a contact already linked to a different customer is a conflict, never
//     overwritten;
//   - a run that would change most of the segment at once (the shape of an
//     upstream outage or a bad price import) needs approval for every write;
//   - past the per-run automatic limit, writes wait for approval;
//   - each write re-reads the contact and refuses if the link changed since.

export const POLICY = { maxAutoWrites: 50, massChangeShare: 0.5, massChangeMin: 20, maxScan: 5000 } as const;
export const FIELDS = ["acme_stripe_customer_id", "acme_plan", "acme_mrr", "acme_billing_status"] as const;

const Input = z.object({
  syncId: z.string().regex(/^SYNC-[\w-]{3,40}$/, "sync id like SYNC-2026-10-22T10"),
  /** Stripe customers with metadata.acme_segment equal to this are in scope. */
  segment: z.string().regex(/^[\w-]{2,60}$/),
  revopsChannel: ChannelId,
  maxAutoWrites: z.number().int().min(0).max(500).default(POLICY.maxAutoWrites),
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

export interface BillingView {
  customerId: string;
  email: string | null;
  plan: string;
  mrr: number;
  status: string;
}
export interface Match {
  billing: BillingView;
  contactId: string | null;
  linkedTo: string | null;
  current: Record<string, string | null>;
}
export type SyncItem =
  | { kind: "write"; customerId: string; contactId: string; patch: Record<string, string>; link: boolean }
  | { kind: "in_sync" | "unmatched"; customerId: string }
  | { kind: "conflict"; customerId: string; contactId: string; linkedTo: string };

/** Monthly recurring revenue in minor units, from live subscription items. */
export function mrrOf(subs: StripeSubscription[]): { plan: string; mrr: number; status: string } {
  const live = subs.filter((s) => ["active", "trialing", "past_due"].includes(s.status));
  let mrr = 0;
  const plans: string[] = [];
  for (const s of live) {
    for (const it of s.items?.data ?? []) {
      const p = it.price;
      if (!p) continue;
      plans.push(p.id);
      const unit = (p.unit_amount ?? 0) * (it.quantity ?? 1);
      mrr += p.recurring?.interval === "year" ? Math.round(unit / 12) : unit;
    }
  }
  const status = live.some((s) => s.status === "past_due") ? "past_due" : live.length ? "active" : subs.length ? "churned" : "none";
  return { plan: [...new Set(plans)].sort().join("+") || "none", mrr, status };
}

/** Pure diff: what each billing customer needs in the CRM. */
export function diff(matches: Match[]): SyncItem[] {
  return matches.map((m): SyncItem => {
    const b = m.billing;
    if (!m.contactId) return { kind: "unmatched", customerId: b.customerId };
    if (m.linkedTo && m.linkedTo !== b.customerId) return { kind: "conflict", customerId: b.customerId, contactId: m.contactId, linkedTo: m.linkedTo };
    const want: Record<string, string> = { acme_stripe_customer_id: b.customerId, acme_plan: b.plan, acme_mrr: String(b.mrr), acme_billing_status: b.status };
    const patch = Object.fromEntries(Object.entries(want).filter(([k, v]) => (m.current[k] ?? "") !== v));
    return Object.keys(patch).length ? { kind: "write", customerId: b.customerId, contactId: m.contactId, patch, link: !m.linkedTo } : { kind: "in_sync", customerId: b.customerId };
  });
}

export const crmBillingSync: WorkflowDef<Input> = {
  id: "crm-billing-sync",
  title: "CRM ↔ billing sync",
  org: "RevOps",
  team: "revops-systems",
  description:
    "Match every Stripe customer in a segment to its HubSpot contact and write the billing-owned fields (plan, MRR, billing status); never overwrite a contact linked to another customer, require approval for runs that would change most of the segment, and cap automatic writes per run.",
  input: Input,
  audit: true,
  tickEvery: "rate(1 hour)",
  agents: [
    {
      name: "billing",
      needs: ["stripe"],
      async run({ input, providers, checkpoint }) {
        const stripe = providers.stripe!;
        const saved = await checkpoint.load<BillingView[]>("billing");
        if (saved) return { summary: `${saved.length} customer(s) (from checkpoint)`, data: saved };
        const customers = (await stripe.listCustomers(POLICY.maxScan)).filter((c) => c.metadata?.acme_segment === input.segment);
        const subs = await stripe.listSubscriptions();
        const canceled = new Map<string, StripeSubscription[]>();
        for (const c of customers) if (!subs.some((s) => s.customer === c.id)) canceled.set(c.id, await stripe.listCanceledSubscriptions(c.id));
        const views: BillingView[] = customers.map((c) => ({ customerId: c.id, email: c.email?.toLowerCase() ?? null, ...mrrOf([...subs.filter((s) => s.customer === c.id), ...(canceled.get(c.id) ?? [])]) }));
        await checkpoint.save("billing", views);
        return { summary: `${views.length} customer(s) in ${input.segment}`, data: views };
      },
    },
  ],

  compose: {
    name: "crm-match",
    async run({ providers }, results) {
      const billing = out<BillingView[]>(results, "billing");
      if (!billing) throw new FatalError("billing could not be read; nothing to match");
      const hs = providers.hubspot!;
      const matches: Match[] = [];
      for (const b of billing) {
        const byLink = (await hs.searchAll([{ propertyName: "acme_stripe_customer_id", operator: "EQ", value: b.customerId }], 2, [...FIELDS]))[0];
        const c = byLink ?? (b.email ? await hs.findByEmail(b.email, [...FIELDS]) : undefined);
        matches.push({ billing: b, contactId: c?.id ?? null, linkedTo: (c?.properties.acme_stripe_customer_id as string | null) || null, current: Object.fromEntries(FIELDS.map((f) => [f, (c?.properties[f] as string | null | undefined) ?? null])) });
      }
      const items = diff(matches);
      const n = (k: SyncItem["kind"]) => items.filter((i) => i.kind === k).length;
      return { summary: `${n("write")} to write, ${n("in_sync")} in sync, ${n("unmatched")} unmatched, ${n("conflict")} conflict(s)`, data: items };
    },
  },

  plan({ input }, results) {
    const items = out<SyncItem[]>(results, "crm-match");
    if (!items) {
      return [
        {
          id: "slack.post_sync",
          kind: "slack.post_sync",
          provider: "slack",
          agent: "billing",
          gate: "auto",
          summary: { blocked: true },
          async execute({ providers }) {
            return { ref: (await providers.slack!.postMessage(input.revopsChannel, `:warning: ${input.syncId}: ${input.segment} could not be read; nothing synced.`)).ts };
          },
        },
      ];
    }
    const writes = items.filter((i): i is Extract<SyncItem, { kind: "write" }> => i.kind === "write");
    const changedExisting = writes.filter((w) => !w.link).length;
    const linked = items.filter((i) => i.kind !== "unmatched").length;
    const mass = changedExisting >= POLICY.massChangeMin && changedExisting / Math.max(1, linked) > POLICY.massChangeShare;
    const actions: PlannedAction<Input>[] = writes.map((w, i) => ({
      id: `hubspot.sync:${w.customerId}`,
      kind: "hubspot.sync",
      provider: "hubspot",
      agent: "crm-match",
      gate: mass || i >= input.maxAutoWrites ? "approval" : "auto",
      summary: { customer: w.customerId, contact: w.contactId, fields: Object.keys(w.patch), ...(mass ? { reason: "mass change" } : {}) },
      async execute({ providers }) {
        const hs = providers.hubspot!;
        const cur = await hs.get(w.contactId, [...FIELDS]);
        const link = (cur.properties.acme_stripe_customer_id as string | null) || null;
        if (link && link !== w.customerId) throw new SkipAction(`contact is now linked to ${link}`);
        const still = Object.fromEntries(Object.entries(w.patch).filter(([k, v]) => (cur.properties[k] ?? "") !== v));
        if (!Object.keys(still).length) throw new SkipAction("already in sync");
        await hs.update(w.contactId, still);
        return { ref: w.contactId, detail: { fields: Object.keys(still) } };
      },
      async reconcile({ providers }) {
        const cur = await providers.hubspot!.get(w.contactId, [...FIELDS]);
        const off = Object.entries(w.patch).filter(([k, v]) => (cur.properties[k] ?? "") !== v).map(([k]) => k);
        return off.length ? { status: "drift", detail: `${off.join(", ")} changed since sync` } : { status: "match" };
      },
    }));
    actions.push({
      id: "slack.post_sync",
      kind: "slack.post_sync",
      provider: "slack",
      agent: "crm-match",
      gate: "auto",
      summary: { writes: writes.length, mass },
      async execute({ providers }) {
        const n = (k: SyncItem["kind"]) => items.filter((x) => x.kind === k).length;
        const conflicts = items.filter((x): x is Extract<SyncItem, { kind: "conflict" }> => x.kind === "conflict").slice(0, 5).map((c) => `${c.customerId} → contact ${c.contactId} (linked to ${c.linkedTo})`);
        const text = [
          `${mass ? ":warning:" : ":arrows_counterclockwise:"} ${input.syncId} ${input.segment}: ${writes.length} contact(s) to update, ${n("in_sync")} in sync, ${n("unmatched")} without a contact, ${n("conflict")} conflict(s).`,
          mass ? `This would change ${changedExisting} of ${linked} linked contacts at once; every write waits for approval.` : "",
          conflicts.length ? `Conflicts (not written): ${conflicts.join("; ")}` : "",
        ].filter(Boolean);
        return { ref: (await providers.slack!.postMessage(input.revopsChannel, text.join("\n"))).ts };
      },
    });
    return actions;
  },

  output(_ctx, results) {
    const items = out<SyncItem[]>(results, "crm-match");
    if (!items) return { mode: "blocked" };
    const n = (k: SyncItem["kind"]) => items.filter((x) => x.kind === k).length;
    return { mode: "sync", customers: items.length, writes: n("write"), inSync: n("in_sync"), unmatched: n("unmatched"), conflicts: n("conflict") };
  },

  catalog: [
    { kind: "hubspot.sync", provider: "hubspot", gate: "auto", description: "Write billing-owned fields (link, plan, MRR, status); approval past the limit or on a mass change" },
    { kind: "slack.post_sync", provider: "slack", gate: "auto", description: "Sync summary with conflicts" },
  ],
};
