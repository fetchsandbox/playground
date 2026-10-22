import { z } from "zod";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import type { StripeCustomer } from "../providers/stripe";
import { Approvers, ChannelId, out } from "./shared";

// RevOps · revops-data.
// Trigger: the nightly data-quality sweep over every Stripe customer of a
// segment (thousands of records). It pages through the whole customer list,
// refuses to trust a scan that didn't really page (a cursor that doesn't
// advance, or fewer records than the billing system says exist), flags
// customers with missing tax country or duplicate emails, and keeps the
// number of automatic writes per run bounded.

export const POLICY = {
  pageSize: 100,
  /** A sweep never reads more than this; beyond it the segment is split. */
  maxRecords: 20_000,
  /** Flags written without approval per run; the rest wait (a bad rule can't rewrite thousands of records). */
  autoFlagMax: 500,
  flagKey: "acme_dq",
} as const;

const Input = z.object({
  /** Customers carry it as metadata `acme_segment`. */
  segment: z.string().regex(/^[\w-]{2,64}$/),
  /** How many customers the billing system says the segment has; a scan that finds fewer is incomplete. */
  expectedMin: z.number().int().min(0).max(POLICY.maxRecords),
  /** Lower the automatic flag limit for this run (never raise it). */
  autoFlagMax: z.number().int().min(0).max(POLICY.autoFlagMax).default(POLICY.autoFlagMax),
  revopsChannel: ChannelId,
  revopsWorkspace: z.string().min(1).default("acme-revops"),
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

export interface Scan {
  pages: number;
  scanned: number;
  /** The provider handed back a page it had already given (cursor ignored). */
  cursorStalled: boolean;
  hitCap: boolean;
  segment: { id: string; email: string | null; country: string | null; flag: string | null }[];
}
export interface Flag {
  customer: string;
  issue: "missing_country" | "duplicate_email";
  gate: "auto" | "approval";
}
export interface Sweep {
  mode: "flag" | "nothing" | "blocked";
  reason: string;
  scanned: number;
  segmentCount: number;
  flags: Flag[];
}

/** Issues per customer, in the scan's order. Pure. */
export function findIssues(segment: Scan["segment"]): Omit<Flag, "gate">[] {
  const byEmail = new Map<string, number>();
  for (const c of segment) if (c.email) byEmail.set(c.email.toLowerCase(), (byEmail.get(c.email.toLowerCase()) ?? 0) + 1);
  const out: Omit<Flag, "gate">[] = [];
  for (const c of segment) {
    const issue = !c.country ? "missing_country" : c.email && byEmail.get(c.email.toLowerCase())! > 1 ? "duplicate_email" : null;
    // Already flagged for the same issue: nothing to write.
    if (issue && c.flag !== issue) out.push({ customer: c.id, issue });
  }
  return out;
}

/** The sweep's decision. Pure. */
export function decide(input: Input, scan: Scan | undefined): Sweep {
  const base = { scanned: scan?.scanned ?? 0, segmentCount: scan?.segment.length ?? 0, flags: [] };
  if (!scan) return { ...base, mode: "blocked", reason: "customers could not be listed" };
  if (scan.cursorStalled) return { ...base, mode: "blocked", reason: `pagination did not advance after page ${scan.pages}; the scan is incomplete` };
  if (scan.hitCap) return { ...base, mode: "blocked", reason: `more than ${POLICY.maxRecords} customers; split the segment` };
  if (scan.segment.length < input.expectedMin) return { ...base, mode: "blocked", reason: `found ${scan.segment.length} of at least ${input.expectedMin} customers in ${input.segment}; the scan is incomplete` };
  const issues = findIssues(scan.segment);
  if (!issues.length) return { ...base, mode: "nothing", reason: "no data-quality issues" };
  return { ...base, mode: "flag", reason: `${issues.length} issue(s)`, flags: issues.map((f, i) => ({ ...f, gate: i < input.autoFlagMax ? "auto" : "approval" })) };
}

export const customerDataSweep: WorkflowDef<Input> = {
  id: "customer-data-sweep",
  title: "Customer data-quality sweep",
  org: "RevOps",
  team: "revops-data",
  description:
    "Page through every Stripe customer of a segment, refuse an incomplete scan (a cursor that doesn't advance or fewer records than expected), flag missing tax country and duplicate emails on the customer, with a per-run limit on automatic writes; summary to Asana and Slack.",
  input: Input,
  agents: [
    {
      name: "customer-scan",
      needs: ["stripe"],
      async run({ input, providers }) {
        const stripe = providers.stripe!;
        const seen = new Set<string>();
        const segment: Scan["segment"] = [];
        let after: string | undefined;
        let pages = 0;
        let cursorStalled = false;
        let hitCap = false;
        for (;;) {
          const page = await stripe.customerPage(POLICY.pageSize, after);
          pages++;
          const fresh = page.data.filter((c) => !seen.has(c.id));
          if (page.data.length && !fresh.length) {
            cursorStalled = true;
            break;
          }
          for (const c of fresh) {
            seen.add(c.id);
            if (c.metadata?.acme_segment === input.segment) segment.push({ id: c.id, email: c.email, country: (c as StripeCustomer & { address?: { country?: string | null } | null }).address?.country ?? null, flag: c.metadata?.[POLICY.flagKey] || null });
          }
          if (seen.size >= POLICY.maxRecords) {
            hitCap = page.has_more;
            break;
          }
          if (!page.has_more || !page.data.length) break;
          after = page.data[page.data.length - 1]!.id;
        }
        const data: Scan = { pages, scanned: seen.size, cursorStalled, hitCap, segment };
        return { summary: `${seen.size} customer(s) over ${pages} page(s), ${segment.length} in ${input.segment}${cursorStalled ? ", cursor stalled" : ""}`, data };
      },
    },
  ],

  compose: {
    name: "sweep-decision",
    async run({ input }, results) {
      const d = decide(input, out<Scan>(results, "customer-scan"));
      return { summary: `${d.mode}: ${d.reason}`, data: d };
    },
  },

  plan({ input }, results) {
    const d = out<Sweep>(results, "sweep-decision");
    if (!d) return [];
    const actions: PlannedAction<Input>[] = d.flags.map((f) => ({
      id: `stripe.flag_customer:${f.customer}`,
      kind: "stripe.flag_customer",
      provider: "stripe",
      agent: "sweep-decision",
      gate: f.gate,
      summary: { customer: f.customer, issue: f.issue },
      async execute({ providers }) {
        const c = await providers.stripe!.updateCustomerMetadata(f.customer, { [POLICY.flagKey]: f.issue });
        return { ref: c.id, detail: { issue: f.issue } };
      },
      async reconcile({ providers }) {
        const c = await providers.stripe!.getCustomer(f.customer);
        return c.metadata?.[POLICY.flagKey] === f.issue ? { status: "match" } : { status: "drift", detail: `flag is ${c.metadata?.[POLICY.flagKey] || "unset"}` };
      },
    }));
    const auto = d.flags.filter((f) => f.gate === "auto").length;
    const lines = [`Segment ${input.segment}: ${d.mode} (${d.reason}).`, `Scanned ${d.scanned} customer(s); ${d.segmentCount} in the segment (expected at least ${input.expectedMin}).`, `Flags: ${d.flags.length} (${auto} automatic, ${d.flags.length - auto} awaiting approval).`];
    if (d.mode !== "nothing") {
      actions.push({
        id: "asana.sweep_record",
        kind: "asana.sweep_record",
        provider: "asana",
        agent: "sweep-decision",
        gate: "auto",
        summary: { segment: input.segment, mode: d.mode },
        async execute({ providers }) {
          const t = await providers.asana!.createTask({ name: `Data-quality sweep ${input.segment}: ${d.mode}`, notes: lines.join("\n"), workspace: input.revopsWorkspace });
          return { ref: t.gid };
        },
      });
    }
    actions.push({
      id: "slack.post_sweep",
      kind: "slack.post_sweep",
      provider: "slack",
      agent: "sweep-decision",
      gate: "auto",
      summary: { channel: input.revopsChannel, mode: d.mode },
      async execute({ providers }) {
        const m = await providers.slack!.postMessage(input.revopsChannel, `${d.mode === "blocked" ? ":rotating_light:" : ":broom:"} ${lines.join(" ")}`);
        return { ref: m.ts };
      },
    });
    return actions;
  },

  output(_ctx, results) {
    const d = out<Sweep>(results, "sweep-decision");
    if (!d) return { mode: "not decided" };
    return { mode: d.mode, reason: d.reason, scanned: d.scanned, segmentCount: d.segmentCount, flags: d.flags.length, flagsAuto: d.flags.filter((f) => f.gate === "auto").length };
  },

  catalog: [
    { kind: "stripe.flag_customer", provider: "stripe", gate: "auto", description: "Flag a customer's data-quality issue in metadata; approval past the per-run limit" },
    { kind: "asana.sweep_record", provider: "asana", gate: "auto", description: "Sweep record for RevOps" },
    { kind: "slack.post_sweep", provider: "slack", gate: "auto", description: "Sweep result in the RevOps channel" },
  ],
};
