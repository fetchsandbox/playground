import { z } from "zod";
import { FatalError, SkipAction } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { ChannelId, money, out } from "./shared";

// Finance · procurement.
// Trigger: a purchase request from the intake form. Vendor status, budget
// headroom, duplicate requests and sanctions screening are checked in parallel;
// then the delegation-of-authority matrix decides who must approve, in order:
//   manager → finance (over 5,000 or over budget) → VP (over 50,000) → CFO (over 250,000).
// Each approver is a signal: never the requester, never someone who already
// approved this request. An approver who hasn't answered in 3 days is reminded;
// at 7 days the step lapses and the request is rejected. Once every step has
// approved, the purchase order is raised in NetSuite exactly once (looked up by
// the request id first) and the requester is told its number.
// An inactive or held vendor, a sanctions match, or a missing vendor stops the
// request before any approval is asked for.

export const DOA = [
  { role: "manager", over: 0 },
  { role: "finance", over: 5_000_00 },
  { role: "vp", over: 50_000_00 },
  { role: "cfo", over: 250_000_00 },
] as const;
type Role = (typeof DOA)[number]["role"];
export const POLICY = { remindAfterDays: 3, lapseAfterDays: 7, duplicateWindowDays: 30 } as const;
const DAY = 86_400_000;

const Input = z.object({
  requestId: z.string().regex(/^PR-[\w-]{3,40}$/, "request id like PR-2026-0042"),
  requester: z.string().regex(/^U[A-Z0-9_]+$/, "requester's Slack user id"),
  vendorId: z.string().regex(/^\d+$/),
  description: z.string().min(3).max(300),
  /** Minor units. */
  amount: z.number().int().positive().max(10_000_000_00),
  currency: z.enum(["usd", "eur", "gbp"]),
  department: z.object({ id: z.string().regex(/^\d+$/), name: z.string().min(1), annualBudget: z.number().int().nonnegative() }),
  expenseAccount: z.string().regex(/^\d+$/),
  approvers: z.object({ manager: z.array(z.string()).min(1), finance: z.array(z.string()).min(1), vp: z.array(z.string()).min(1), cfo: z.array(z.string()).min(1) }),
  procurementChannel: ChannelId,
});
type Input = z.infer<typeof Input>;

interface Vendor {
  name: string;
  usable: boolean;
  reason: string | null;
}
interface Budget {
  committed: number;
  remaining: number;
}

/** Who must approve, in order. Over budget always brings finance in. */
export function chain(amount: number, overBudget: boolean): Role[] {
  const roles: Role[] = DOA.filter((d) => amount > d.over).map((d) => d.role);
  if (overBudget && !roles.includes("finance")) roles.splice(1, 0, "finance");
  return roles;
}

export const purchaseRequestToPo: WorkflowDef<Input> = {
  id: "purchase-request-to-po",
  title: "Purchase request to purchase order",
  org: "Finance",
  team: "procurement",
  description:
    "Check a purchase request's vendor, budget, duplicates and sanctions in parallel, route it through the delegation-of-authority chain (manager, finance, VP, CFO by amount; finance whenever over budget) with no self- or repeat approval, remind and lapse slow approvers, then raise the NetSuite purchase order exactly once and tell the requester.",
  input: Input,
  audit: true,
  tickEvery: "rate(1 hour)",
  agents: [
    {
      name: "vendor",
      needs: ["netsuite"],
      async run({ input, providers }) {
        const v = await providers.netsuite!.getVendor(input.vendorId);
        const reason = v.isInactive ? "vendor is inactive" : v.custentity_acme_payment_hold ? `vendor is on hold (${v.custentity_acme_hold_reason ?? "no reason recorded"})` : null;
        return { summary: `${v.companyName ?? v.id}${reason ? `: ${reason}` : ""}`, data: { name: v.legalName || v.companyName || v.id, usable: !reason, reason } satisfies Vendor };
      },
    },
    {
      name: "budget",
      needs: ["netsuite"],
      async run({ input, providers, startedAt }) {
        const fy = `${startedAt.getUTCFullYear()}-01-01`;
        const [row] = await providers.netsuite!.suiteql<{ amount: number | string | null }>(`SELECT SUM(foreigntotal) AS amount FROM transaction WHERE type = 'PurchOrd' AND department = ${input.department.id} AND trandate >= TO_DATE('${fy}', 'YYYY-MM-DD')`);
        // SuiteQL returns major units.
        const committed = Math.round(Number(row?.amount ?? 0) * 100);
        const data: Budget = { committed, remaining: input.department.annualBudget - committed };
        return { summary: `${input.department.name}: ${money(data.remaining, input.currency)} remaining`, data };
      },
    },
    {
      name: "duplicates",
      needs: ["netsuite"],
      async run({ input, providers, startedAt }) {
        const since = new Date(startedAt.getTime() - POLICY.duplicateWindowDays * DAY).toISOString().slice(0, 10);
        const rows = await providers.netsuite!.suiteql<{ id: string | number; tranid?: string }>(`SELECT id, tranid FROM transaction WHERE type = 'PurchOrd' AND entity = ${input.vendorId} AND foreigntotal = ${(input.amount / 100).toFixed(2)} AND trandate >= TO_DATE('${since}', 'YYYY-MM-DD')`);
        return { summary: `${rows.length} similar PO(s) in ${POLICY.duplicateWindowDays} days`, data: rows.map((r) => r.tranid ?? String(r.id)) };
      },
    },
    {
      name: "screening",
      needs: ["netsuite", "screening"],
      async run({ input, providers }) {
        const v = await providers.netsuite!.getVendor(input.vendorId);
        const hits = (await providers.screening!.search(v.legalName || v.companyName || "")).filter((h) => (h.score ?? 100) >= 90);
        return { summary: hits.length ? `${hits.length} sanctions match(es)` : "no sanctions match", data: hits.map((h) => `${h.name} (${h.source})`) };
      },
    },
  ],

  plan({ input, startedAt }, results) {
    const vendor = out<Vendor>(results, "vendor");
    const budget = out<Budget>(results, "budget");
    const dups = out<string[]>(results, "duplicates");
    const hits = out<string[]>(results, "screening");
    const amount = money(input.amount, input.currency);
    const stop = !vendor ? "the vendor could not be read" : !vendor.usable ? vendor.reason : hits === undefined ? "sanctions screening could not run" : hits.length ? `sanctions match: ${hits.join("; ")}` : !budget ? "the budget could not be read" : null;
    const tell = (id: string, text: string): PlannedAction<Input> => ({
      id,
      kind: id,
      provider: "slack",
      agent: "vendor",
      gate: "auto",
      summary: { requestId: input.requestId },
      async execute({ providers }) {
        return { ref: (await providers.slack!.postMessage(input.procurementChannel, text)).ts };
      },
    });
    if (stop) return [tell("slack.post_stopped", `:no_entry: ${input.requestId} (${amount}, vendor ${input.vendorId}) stopped: ${stop}. <@${input.requester}>, procurement will follow up.`)];

    const overBudget = input.amount > budget!.remaining;
    const roles = chain(input.amount, overBudget);
    const actions: PlannedAction<Input>[] = [
      tell(
        "slack.post_request",
        `:receipt: ${input.requestId} from <@${input.requester}>: ${input.description} — ${amount} to ${vendor!.name} (${input.department.name}). Approvals: ${roles.join(" → ")}.${overBudget ? ` Over budget: ${money(budget!.remaining, input.currency)} left.` : ""}${dups?.length ? ` :warning: Possible duplicate of ${dups.join(", ")}.` : ""}`,
      ),
    ];
    const lapse = new Date(startedAt.getTime() + POLICY.lapseAfterDays * DAY).toISOString();
    const ids: string[] = [];
    roles.forEach((role, i) => {
      const id = `approve.${role}:${input.requestId}`;
      actions.push({
        id,
        kind: `approve.${role}`,
        provider: "slack",
        agent: "vendor",
        gate: "auto",
        summary: { requestId: input.requestId, role, amount, step: `${i + 1}/${roles.length}`, ...(dups?.length ? { possibleDuplicateOf: dups } : {}) },
        awaitSignal: { from: input.approvers[role], notFrom: [input.requester], distinctFrom: [...ids], deadline: lapse, onDeadline: "reject" },
        requires: ids.length ? [ids[ids.length - 1]!] : [],
        async execute({ signal }) {
          return { ref: signal!.by, detail: { role } };
        },
      });
      ids.push(id);
    });
    actions.push({
      id: `slack.remind:${input.requestId}`,
      kind: "slack.remind",
      provider: "slack",
      agent: "vendor",
      gate: "auto",
      summary: { requestId: input.requestId, afterDays: POLICY.remindAfterDays },
      waitUntil: new Date(startedAt.getTime() + POLICY.remindAfterDays * DAY).toISOString(),
      async execute({ providers, statuses }) {
        const waiting = ids.find((id) => statuses[id] === "awaiting_signal");
        if (!waiting) throw new SkipAction("no approval pending");
        const role = waiting.split(":")[0]!.split(".")[1] as Role;
        const who = input.approvers[role].map((u) => `<@${u}>`).join(" ");
        return { ref: (await providers.slack!.postMessage(input.procurementChannel, `:hourglass: ${input.requestId} (${amount}) has waited ${POLICY.remindAfterDays} days for ${role} approval: ${who}. It lapses on ${lapse.slice(0, 10)}.`)).ts };
      },
    });
    const po = `netsuite.create_po:${input.requestId}`;
    actions.push({
      id: po,
      kind: "netsuite.create_po",
      provider: "netsuite",
      agent: "vendor",
      gate: "auto",
      summary: { requestId: input.requestId, vendor: input.vendorId, amount },
      requires: [ids[ids.length - 1]!],
      async execute({ providers }) {
        const ns = providers.netsuite!;
        const existing = await ns.findPurchaseOrder(input.requestId);
        if (existing) return { ref: existing.id, detail: { reused: true, tranId: existing.tranId } };
        // Re-check the vendor at write time: a hold placed during approval stops the PO.
        const v = await ns.getVendor(input.vendorId);
        if (v.isInactive || v.custentity_acme_payment_hold) throw new FatalError(`vendor ${input.vendorId} was put on hold during approval`);
        const created = await ns.createPurchaseOrder({ externalId: input.requestId, vendorId: input.vendorId, department: input.department.id, memo: `${input.requestId}: ${input.description}`, lines: [{ description: input.description, amount: input.amount / 100, account: input.expenseAccount }] });
        const found = await ns.findPurchaseOrder(input.requestId);
        return { ref: created.id, detail: { tranId: found?.tranId } };
      },
      async reconcile({ providers }, receipt) {
        const p = await providers.netsuite!.getPurchaseOrder(receipt.ref);
        return p.entity?.id === input.vendorId ? { status: "match" } : { status: "drift", detail: `PO vendor is now ${p.entity?.id}` };
      },
    });
    actions.push({
      id: `slack.dm_requester:${input.requestId}`,
      kind: "slack.dm_requester",
      provider: "slack",
      agent: "vendor",
      gate: "auto",
      summary: { requestId: input.requestId },
      after: [po, ...ids],
      async execute({ providers, applied, statuses }) {
        const r = applied[po];
        const text = r ? `Your purchase request ${input.requestId} is approved: purchase order ${String(r.detail?.tranId ?? r.ref)} for ${amount} with ${vendor!.name}.` : `Your purchase request ${input.requestId} (${amount}) was not approved${ids.some((id) => statuses[id] === "rejected") ? "" : " in time"}; no purchase order was raised.`;
        return { ref: (await providers.slack!.postMessage(input.requester, text)).ts };
      },
    });
    return actions;
  },

  output({ input }, results) {
    const vendor = out<Vendor>(results, "vendor");
    const budget = out<Budget>(results, "budget");
    const hits = out<string[]>(results, "screening");
    if (!vendor || !vendor.usable || !hits || hits.length || !budget) return { mode: "stopped" };
    const overBudget = input.amount > budget.remaining;
    return { mode: "approval", chain: chain(input.amount, overBudget), overBudget, possibleDuplicates: out<string[]>(results, "duplicates")?.length ?? null };
  },

  catalog: [
    { kind: "slack.post_stopped", provider: "slack", gate: "auto", description: "Vendor inactive, on hold, sanctioned or unreadable: nothing is approved" },
    { kind: "slack.post_request", provider: "slack", gate: "auto", description: "Request, approval chain, budget and duplicate warning" },
    { kind: "approve.manager", provider: "slack", gate: "auto", description: "Signal: requester's manager" },
    { kind: "approve.finance", provider: "slack", gate: "auto", description: "Signal: finance (over 5,000 or over budget)" },
    { kind: "approve.vp", provider: "slack", gate: "auto", description: "Signal: VP (over 50,000)" },
    { kind: "approve.cfo", provider: "slack", gate: "auto", description: "Signal: CFO (over 250,000)" },
    { kind: "slack.remind", provider: "slack", gate: "auto", description: "Reminder to the pending approver after 3 days" },
    { kind: "netsuite.create_po", provider: "netsuite", gate: "auto", description: "Purchase order, once per request" },
    { kind: "slack.dm_requester", provider: "slack", gate: "auto", description: "PO number, or why there is none" },
  ],
};
