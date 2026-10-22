import { z } from "zod";
import { SkipAction } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import type { NetSuitePurchaseOrder, NetSuiteVendorBill } from "../providers/commerce";
import { Approvers, ChannelId, money, out } from "./shared";

// Finance · accounts-payable.
// Trigger: the AP batch (hourly or daily). Every vendor bill pending approval
// is matched line by line against its purchase order and what was received
// (three-way match). Code decides; people handle only exceptions, by risk:
//   - clean match within the auto-approval limit → approved automatically;
//   - small price variance within tolerance → an AP approver confirms
//     (never the person who entered the bill), or it stays pending at the deadline;
//   - price over tolerance, billed more than received, no purchase order →
//     payment hold and a buyer's decision;
//   - suspected duplicate (same vendor and invoice number, or same vendor,
//     amount and date) → hold, never approved by the automation.
// The scan is checkpointed per bill, so a restart continues where it stopped.

export const POLICY = {
  autoApproveMaxMinor: 2_500_000,
  /** Price variance per line that an AP approver may accept. */
  priceTolerancePct: 2,
  priceToleranceMinor: 5_000,
  maxBillsPerRun: 200,
  approvalDays: 3,
  /** Bills with the same vendor and amount this close together are possible duplicates. */
  duplicateWindowDays: 30,
} as const;

const Input = z.object({
  batchId: z.string().regex(/^AP-[\w-]{3,40}$/, "batch id like AP-2026-10-22"),
  /** Bill ids to match; the batch's pending bills when omitted. */
  billIds: z.array(z.string().regex(/^\d{1,12}$/)).max(POLICY.maxBillsPerRun).optional(),
  apChannel: ChannelId,
  apWorkspace: z.string().min(1).default("acme-ap"),
  /** AP approvers for tolerance variances; buyers for exceptions. */
  approvers: Approvers,
  buyers: z.array(z.string().min(1)).min(1).max(50),
});
type Input = z.infer<typeof Input>;

export type Verdict = "match" | "variance" | "exception" | "duplicate";
export interface BillResult {
  billId: string;
  tranId: string;
  vendorId: string;
  totalMinor: number;
  enteredBy: string | null;
  verdict: Verdict;
  reasons: string[];
}

const DAY = 86_400_000;
const minor = (n: number | undefined) => Math.round((n ?? 0) * 100);

/** One bill against its POs. Pure. */
export function matchBill(bill: NetSuiteVendorBill, pos: Record<string, NetSuitePurchaseOrder>, duplicates: string[]): BillResult {
  const reasons: string[] = [];
  let verdict: Verdict = "match";
  const worse = (v: Verdict) => {
    const rank: Record<Verdict, number> = { match: 0, variance: 1, exception: 2, duplicate: 3 };
    if (rank[v] > rank[verdict]) verdict = v;
  };
  if (duplicates.length) {
    worse("duplicate");
    reasons.push(`possible duplicate of bill ${duplicates.join(", ")}`);
  }
  const lines = bill.item?.items ?? [];
  if (!lines.length) {
    worse("exception");
    reasons.push("bill has no lines");
  }
  for (const [i, l] of lines.entries()) {
    const po = l.orderDoc?.id ? pos[l.orderDoc.id] : undefined;
    if (!po) {
      worse("exception");
      reasons.push(`line ${i + 1}: no purchase order`);
      continue;
    }
    const pl = po.item?.items.find((x) => x.line === l.orderLine) ?? po.item?.items.find((x) => x.item.id === l.item.id);
    if (!pl) {
      worse("exception");
      reasons.push(`line ${i + 1}: item ${l.item.id} not on PO ${po.tranId ?? po.id}`);
      continue;
    }
    const receivedNotBilled = pl.quantityReceived - pl.quantityBilled;
    if (l.quantity > receivedNotBilled) {
      worse("exception");
      reasons.push(`line ${i + 1}: billed ${l.quantity}, received and unbilled ${receivedNotBilled}`);
    }
    const diff = Math.abs(minor(l.rate) - minor(pl.rate)) * l.quantity;
    if (diff > 0) {
      const pct = (Math.abs(l.rate - pl.rate) / pl.rate) * 100;
      if (pct <= POLICY.priceTolerancePct && diff <= POLICY.priceToleranceMinor) {
        worse("variance");
        reasons.push(`line ${i + 1}: price ${l.rate} vs PO ${pl.rate} (${pct.toFixed(1)}%, within tolerance)`);
      } else {
        worse("exception");
        reasons.push(`line ${i + 1}: price ${l.rate} vs PO ${pl.rate} (${pct.toFixed(1)}%, ${money(diff, "usd")} over)`);
      }
    }
  }
  const total = minor(bill.total);
  if (verdict === "match" && total > POLICY.autoApproveMaxMinor) {
    verdict = "variance";
    reasons.push(`total ${money(total, "usd")} above the automatic approval limit`);
  }
  return { billId: bill.id, tranId: bill.tranId ?? bill.id, vendorId: bill.entity?.id ?? "", totalMinor: total, enteredBy: bill.createdBy?.id ?? null, verdict, reasons };
}

export const invoiceThreeWayMatch: WorkflowDef<Input> = {
  id: "invoice-three-way-match",
  title: "Invoice three-way match",
  org: "Finance",
  team: "accounts-payable",
  description:
    "Match every pending NetSuite vendor bill against its purchase order and receipts: clean matches are approved automatically, tolerance variances by an AP approver who didn't enter the bill, exceptions and suspected duplicates are held for a buyer; checkpointed per bill.",
  input: Input,
  audit: true,
  tickEvery: "rate(1 hour)",
  agents: [
    {
      name: "match-engine",
      needs: ["netsuite"],
      async run({ input, providers, checkpoint }) {
        const ns = providers.netsuite!;
        const ids = input.billIds ?? (await ns.suiteql<{ id: string | number }>(`SELECT id FROM transaction WHERE type = 'VendBill' AND approvalstatus = 1 ORDER BY id FETCH FIRST ${POLICY.maxBillsPerRun} ROWS ONLY`)).map((r) => String(r.id));
        const done = (await checkpoint.load<Record<string, BillResult>>("bills")) ?? {};
        for (const id of ids) {
          if (done[id]) continue;
          const bill = await ns.getVendorBill(id);
          const poIds = [...new Set((bill.item?.items ?? []).map((l) => l.orderDoc?.id).filter((x): x is string => !!x))];
          const pos: Record<string, NetSuitePurchaseOrder> = {};
          for (const p of poIds) pos[p] = await ns.getPurchaseOrder(p);
          const since = new Date(Date.parse(bill.tranDate ?? new Date().toISOString()) - POLICY.duplicateWindowDays * DAY).toISOString().slice(0, 10);
          const dups = (await ns.suiteql<{ id: string | number }>(`SELECT id FROM transaction WHERE type = 'VendBill' AND entity = ${Number(bill.entity?.id ?? 0)} AND id <> ${Number(id)} AND (tranid = '${(bill.tranId ?? "").replaceAll("'", "''")}' OR (foreigntotal = ${Number(bill.total ?? 0)} AND trandate >= TO_DATE('${since}', 'YYYY-MM-DD')))`)).map((r) => String(r.id));
          done[id] = matchBill(bill, pos, dups);
          await checkpoint.save("bills", done);
        }
        const results = ids.map((id) => done[id]!);
        const count = (v: Verdict) => results.filter((r) => r.verdict === v).length;
        return { summary: `${results.length} bill(s): ${count("match")} match, ${count("variance")} variance, ${count("exception")} exception, ${count("duplicate")} duplicate`, data: results };
      },
    },
  ],

  plan({ input, startedAt }, results) {
    const bills = out<BillResult[]>(results, "match-engine");
    if (!bills) {
      return [
        {
          id: "slack.post_batch",
          kind: "slack.post_batch",
          provider: "slack",
          agent: "match-engine",
          gate: "auto",
          summary: { channel: input.apChannel, blocked: true },
          async execute({ providers }) {
            const m = await providers.slack!.postMessage(input.apChannel, `:rotating_light: ${input.batchId}: bills could not be read; nothing was approved.`);
            return { ref: m.ts };
          },
        },
      ];
    }
    const deadline = new Date(startedAt.getTime() + POLICY.approvalDays * DAY).toISOString();
    const actions: PlannedAction<Input>[] = [];
    for (const b of bills) {
      if (b.verdict === "match") {
        actions.push({
          id: `netsuite.approve_bill:${b.billId}`,
          kind: "netsuite.approve_bill",
          provider: "netsuite",
          agent: "match-engine",
          gate: "auto",
          summary: { bill: b.tranId, total: money(b.totalMinor, "usd"), how: "clean three-way match" },
          async execute({ providers }) {
            // Re-read: someone may have changed the bill since the match.
            const cur = await providers.netsuite!.getVendorBill(b.billId);
            if (cur.approvalStatus?.id !== "1") throw new SkipAction(`bill is no longer pending (status ${cur.approvalStatus?.id})`);
            if (minor(cur.total) !== b.totalMinor) throw new SkipAction(`bill total changed to ${money(minor(cur.total), "usd")} since the match`);
            await providers.netsuite!.updateVendorBill(b.billId, { approvalStatus: { id: "2" } });
            return { ref: b.billId };
          },
          async reconcile({ providers }) {
            const cur = await providers.netsuite!.getVendorBill(b.billId);
            return cur.approvalStatus?.id === "2" ? { status: "match" } : { status: "drift", detail: `approval status ${cur.approvalStatus?.id}` };
          },
        });
      } else if (b.verdict === "variance") {
        actions.push({
          id: `netsuite.approve_bill:${b.billId}`,
          kind: "netsuite.approve_bill",
          provider: "netsuite",
          agent: "match-engine",
          gate: "auto",
          summary: { bill: b.tranId, total: money(b.totalMinor, "usd"), how: "AP approval of a tolerance variance", reasons: b.reasons },
          awaitSignal: { from: input.approvers ?? [], notFrom: b.enteredBy ? [b.enteredBy] : [], deadline, onDeadline: "reject" },
          async execute({ providers, signal }) {
            const cur = await providers.netsuite!.getVendorBill(b.billId);
            if (cur.approvalStatus?.id !== "1") throw new SkipAction(`bill is no longer pending (status ${cur.approvalStatus?.id})`);
            await providers.netsuite!.updateVendorBill(b.billId, { approvalStatus: { id: "2" } });
            return { ref: b.billId, detail: { approvedBy: signal?.by } };
          },
        });
      } else {
        const reason = `${b.verdict}: ${b.reasons.join("; ")}`.slice(0, 300);
        actions.push({
          id: `netsuite.hold_bill:${b.billId}`,
          kind: "netsuite.hold_bill",
          provider: "netsuite",
          agent: "match-engine",
          gate: "auto",
          summary: { bill: b.tranId, verdict: b.verdict },
          async execute({ providers }) {
            await providers.netsuite!.updateVendorBill(b.billId, { paymentHold: true, custbody_acme_hold_reason: reason });
            return { ref: b.billId };
          },
        });
        actions.push({
          id: `asana.exception:${b.billId}`,
          kind: "asana.exception",
          provider: "asana",
          agent: "match-engine",
          gate: "auto",
          summary: { bill: b.tranId, verdict: b.verdict },
          async execute({ providers }) {
            const t = await providers.asana!.createTask({ name: `${b.tranId}: ${b.verdict} (vendor ${b.vendorId})`, notes: [`Batch ${input.batchId}. ${money(b.totalMinor, "usd")}.`, ...b.reasons, b.verdict === "duplicate" ? "Never approve automatically: confirm with the vendor that this is not a resubmission." : "A buyer decides: correct the PO or receipt, or reject the bill."].join("\n"), workspace: input.apWorkspace });
            return { ref: t.gid };
          },
        });
        if (b.verdict === "exception") {
          // A buyer may still release it (approve = approve the bill as billed).
          actions.push({
            id: `netsuite.buyer_release:${b.billId}`,
            kind: "netsuite.buyer_release",
            provider: "netsuite",
            agent: "match-engine",
            gate: "auto",
            summary: { bill: b.tranId, meaning: "approve = release and approve as billed" },
            awaitSignal: { from: input.buyers, notFrom: b.enteredBy ? [b.enteredBy] : [], deadline, onDeadline: "reject" },
            requires: [`netsuite.hold_bill:${b.billId}`],
            async execute({ providers, signal }) {
              await providers.netsuite!.updateVendorBill(b.billId, { paymentHold: false, custbody_acme_hold_reason: null, approvalStatus: { id: "2" } });
              return { ref: b.billId, detail: { releasedBy: signal?.by } };
            },
          });
        }
      }
    }
    const count = (v: Verdict) => bills.filter((r) => r.verdict === v).length;
    actions.push({
      id: "slack.post_batch",
      kind: "slack.post_batch",
      provider: "slack",
      agent: "match-engine",
      gate: "auto",
      summary: { channel: input.apChannel },
      async execute({ providers }) {
        const m = await providers.slack!.postMessage(input.apChannel, `:receipt: ${input.batchId}: ${bills.length} bill(s); ${count("match")} approved automatically, ${count("variance")} variance(s) for AP, ${count("exception")} exception(s) and ${count("duplicate")} possible duplicate(s) on hold.`);
        return { ref: m.ts };
      },
    });
    return actions;
  },

  output(_ctx, results) {
    const bills = out<BillResult[]>(results, "match-engine");
    if (!bills) return { mode: "blocked" };
    const count = (v: Verdict) => bills.filter((r) => r.verdict === v).length;
    return { mode: "matched", bills: bills.length, match: count("match"), variance: count("variance"), exception: count("exception"), duplicate: count("duplicate") };
  },

  catalog: [
    { kind: "netsuite.approve_bill", provider: "netsuite", gate: "auto", description: "Approve a clean match automatically; tolerance variances by an AP approver who didn't enter the bill" },
    { kind: "netsuite.hold_bill", provider: "netsuite", gate: "auto", description: "Payment hold on exceptions and suspected duplicates" },
    { kind: "asana.exception", provider: "asana", gate: "auto", description: "Exception task with the reasons" },
    { kind: "netsuite.buyer_release", provider: "netsuite", gate: "auto", description: "Signal: a buyer releases an exception as billed" },
    { kind: "slack.post_batch", provider: "slack", gate: "auto", description: "Batch summary" },
  ],
};
