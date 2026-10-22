import { z } from "zod";
import { FatalError, SkipAction } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import type { GustoPayroll } from "../providers/commerce";
import { ChannelId, money, out } from "./shared";

// People · payroll-ops (with finance).
// Trigger: a regular Gusto payroll is ready for review. Before it is submitted,
// each employee's gross pay is compared with their median over the last three
// processed regular payrolls; anomalies are:
//   - paid after their termination date (always critical);
//   - gross up more than 25% and more than 500 on their median;
//   - a first payroll over the new-hire limit.
// A clean payroll is submitted at once. Otherwise a reviewer who didn't prepare
// the payroll decides before Gusto's deadline (signal): approve = pay as is.
// Without approval by two hours before the deadline, the flagged employees are
// excluded (prepare, then update with its version) and everyone else is paid on
// time; payroll-ops is told to run an off-cycle payroll for those held back.

export const POLICY = { upShare: 0.25, upMinMinor: 500_00, newHireMaxMinor: 15_000_00, historyRuns: 3, decideBeforeDeadlineMs: 2 * 3_600_000 } as const;

const Input = z.object({
  reviewId: z.string().regex(/^PAYREV-[\w-]{3,40}$/, "review id like PAYREV-2026-10-31"),
  payrollId: z.string().min(3).max(64),
  preparer: z.string().regex(/^U[A-Z0-9_]+$/),
  reviewers: z.array(z.string()).min(1),
  payrollChannel: ChannelId,
});
type Input = z.infer<typeof Input>;

export interface Flag {
  employee: string;
  name: string;
  grossMinor: number;
  medianMinor: number | null;
  reason: string;
  critical: boolean;
}

const minor = (s: string | null | undefined) => Math.round(Number(s ?? 0) * 100);
const median = (xs: number[]) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? (v.length % 2 ? v[(v.length - 1) / 2]! : Math.round((v[v.length / 2 - 1]! + v[v.length / 2]!) / 2)) : null;
};

/** Pure anomaly check for one payroll. */
export function flags(current: GustoPayroll, history: GustoPayroll[], employees: { uuid: string; name: string; terminatedOn: string | null }[]): Flag[] {
  const start = current.pay_period?.start_date ?? current.check_date ?? "9999-12-31";
  const out: Flag[] = [];
  for (const c of current.employee_compensations ?? []) {
    if (c.excluded) continue;
    const gross = minor(c.gross_pay);
    if (gross <= 0) continue;
    const e = employees.find((x) => x.uuid === c.employee_uuid);
    const name = e?.name ?? c.employee_uuid;
    const past = history.flatMap((h) => (h.employee_compensations ?? []).filter((x) => x.employee_uuid === c.employee_uuid && !x.excluded).map((x) => minor(x.gross_pay)));
    const med = median(past);
    if (e?.terminatedOn && e.terminatedOn < start) out.push({ employee: c.employee_uuid, name, grossMinor: gross, medianMinor: med, reason: `paid after termination on ${e.terminatedOn}`, critical: true });
    else if (med === null && gross > POLICY.newHireMaxMinor) out.push({ employee: c.employee_uuid, name, grossMinor: gross, medianMinor: null, reason: `first payroll over ${money(POLICY.newHireMaxMinor)}`, critical: false });
    else if (med !== null && gross > med * (1 + POLICY.upShare) && gross - med > POLICY.upMinMinor) out.push({ employee: c.employee_uuid, name, grossMinor: gross, medianMinor: med, reason: `gross up ${Math.round(((gross - med) / med) * 100)}% on the ${history.length}-payroll median`, critical: false });
  }
  return out;
}

export const payrollAnomalyReview: WorkflowDef<Input> = {
  id: "payroll-anomaly-review",
  title: "Payroll anomaly review",
  org: "People",
  team: "payroll-ops",
  description:
    "Compare each employee's gross pay on an upcoming Gusto payroll with their recent median, flag pay after termination, large increases and oversized first payrolls; submit clean payrolls at once, otherwise wait for a reviewer who didn't prepare it and, without approval before the deadline, exclude the flagged employees and pay everyone else on time.",
  input: Input,
  audit: true,
  tickEvery: "rate(15 minutes)",
  agents: [
    {
      name: "payroll",
      needs: ["gusto"],
      async run({ input, providers }) {
        const g = providers.gusto!;
        const current = await g.getPayroll(input.payrollId);
        if (current.processed) return { summary: "already processed", data: { current, history: [] } };
        const since = new Date(Date.parse(current.check_date ?? new Date().toISOString()) - 120 * 86_400_000).toISOString().slice(0, 10);
        const prior = (await g.listPayrolls(since)).filter((p) => p.uuid !== input.payrollId && !p.off_cycle && (p as GustoPayroll).processed && (p.check_date ?? "") < (current.check_date ?? "")).sort((a, b) => (b.check_date ?? "").localeCompare(a.check_date ?? "")).slice(0, POLICY.historyRuns);
        const history = await Promise.all(prior.map((p) => g.getPayroll(p.uuid)));
        return { summary: `${current.employee_compensations?.length ?? 0} employee(s); ${history.length} prior payroll(s); deadline ${current.payroll_deadline ?? "unknown"}`, data: { current, history } };
      },
    },
    {
      name: "employees",
      needs: ["gusto"],
      async run({ providers }) {
        const list = (await providers.gusto!.listEmployees()).map((e) => ({ uuid: e.uuid, name: [e.first_name, e.last_name].filter(Boolean).join(" ") || e.uuid, terminatedOn: e.terminations?.map((t) => t.effective_date).sort().at(-1) ?? null }));
        return { summary: `${list.length} employee(s), ${list.filter((e) => e.terminatedOn).length} with a termination`, data: list };
      },
    },
  ],

  compose: {
    name: "anomalies",
    async run(_ctx, results) {
      const p = out<{ current: GustoPayroll; history: GustoPayroll[] }>(results, "payroll");
      const e = out<{ uuid: string; name: string; terminatedOn: string | null }[]>(results, "employees");
      if (!p || !e) throw new FatalError("payroll or employees unavailable; nothing will be submitted");
      const f = p.current.processed ? [] : flags(p.current, p.history, e);
      return { summary: `${f.length} anomaly(ies), ${f.filter((x) => x.critical).length} critical`, data: { flags: f, processed: !!p.current.processed, deadline: p.current.payroll_deadline ?? null, checkDate: p.current.check_date ?? null } };
    },
  },

  plan({ input }, results) {
    const a = out<{ flags: Flag[]; processed: boolean; deadline: string | null; checkDate: string | null }>(results, "anomalies");
    const post = (id: string, text: string): PlannedAction<Input> => ({
      id,
      kind: id,
      provider: "slack",
      agent: "anomalies",
      gate: "auto",
      summary: { payroll: input.payrollId },
      async execute({ providers }) {
        return { ref: (await providers.slack!.postMessage(input.payrollChannel, text)).ts };
      },
    });
    if (!a) return [post("slack.post_blocked", `:warning: ${input.reviewId}: payroll ${input.payrollId} could not be reviewed (Gusto unreadable). It has not been submitted; check it by hand before the deadline.`)];
    if (a.processed) return [];
    const submit: PlannedAction<Input> = {
      id: `gusto.submit:${input.payrollId}`,
      kind: "gusto.submit",
      provider: "gusto",
      agent: "anomalies",
      gate: "auto",
      summary: { payroll: input.payrollId, checkDate: a.checkDate, flagged: a.flags.length },
      async execute({ providers }) {
        const p = await providers.gusto!.getPayroll(input.payrollId);
        if (p.processed) throw new SkipAction("already submitted");
        await providers.gusto!.submitPayroll(input.payrollId);
        return { ref: input.payrollId, detail: { excluded: (p.employee_compensations ?? []).filter((c) => c.excluded).map((c) => c.employee_uuid) } };
      },
    };
    if (!a.flags.length) return [submit];

    const review = `payroll.review:${input.payrollId}`;
    const exclude = `gusto.exclude_flagged:${input.payrollId}`;
    const deadline = a.deadline ? new Date(Date.parse(a.deadline) - POLICY.decideBeforeDeadlineMs).toISOString() : undefined;
    const lines = a.flags.map((f) => `• ${f.critical ? ":rotating_light: " : ""}${f.name}: ${money(f.grossMinor)}${f.medianMinor !== null ? ` (median ${money(f.medianMinor)})` : ""}: ${f.reason}`);
    return [
      post("slack.post_anomalies", [`:mag: ${input.reviewId}: payroll ${input.payrollId} (check date ${a.checkDate}) has ${a.flags.length} anomaly(ies). A reviewer other than <@${input.preparer}> must approve before ${deadline?.slice(0, 16).replace("T", " ") ?? "the deadline"} UTC, or these employees are held back and everyone else is paid.`, ...lines].join("\n")),
      {
        id: review,
        kind: "payroll.review",
        provider: "gusto",
        agent: "anomalies",
        gate: "auto",
        summary: { payroll: input.payrollId, flags: a.flags.map((f) => `${f.name}: ${f.reason}`), meaning: "approve = pay as is; reject or no answer = hold the flagged employees" },
        awaitSignal: { from: input.reviewers, notFrom: [input.preparer], ...(deadline ? { deadline, onDeadline: "reject" as const } : {}) },
        async execute({ signal }) {
          return { ref: signal!.by };
        },
      },
      {
        id: exclude,
        kind: "gusto.exclude_flagged",
        provider: "gusto",
        agent: "anomalies",
        gate: "auto",
        summary: { payroll: input.payrollId, employees: a.flags.map((f) => f.employee) },
        after: [review],
        async execute({ providers, statuses }) {
          if (statuses[review] === "applied") throw new SkipAction("reviewer approved paying as is");
          const g = providers.gusto!;
          const p = await g.getPayroll(input.payrollId);
          if (p.processed) throw new SkipAction("already submitted");
          await g.excludeEmployees(input.payrollId, a.flags.map((f) => f.employee));
          await providers.slack!.postMessage(input.payrollChannel, `:pause_button: ${input.reviewId}: ${a.flags.length} employee(s) held back from payroll ${input.payrollId} (${a.flags.map((f) => f.name).join(", ")}). Run an off-cycle payroll once each is resolved.`);
          return { ref: input.payrollId, detail: { excluded: a.flags.map((f) => f.employee) } };
        },
      },
      { ...submit, after: [review, exclude] },
    ];
  },

  output(_ctx, results) {
    const a = out<{ flags: Flag[]; processed: boolean }>(results, "anomalies");
    if (!a) return { mode: "blocked" };
    if (a.processed) return { mode: "already_processed" };
    return { mode: a.flags.length ? "review" : "clean", flagged: a.flags.length, critical: a.flags.filter((f) => f.critical).length };
  },

  catalog: [
    { kind: "slack.post_anomalies", provider: "slack", gate: "auto", description: "Anomalies, who may approve and the decision deadline" },
    { kind: "payroll.review", provider: "gusto", gate: "auto", description: "Signal: a reviewer who didn't prepare the payroll approves paying as is" },
    { kind: "gusto.exclude_flagged", provider: "gusto", gate: "auto", description: "Without approval, exclude the flagged employees (prepare, then version-guarded update)" },
    { kind: "gusto.submit", provider: "gusto", gate: "auto", description: "Submit the payroll so everyone else is paid on time" },
    { kind: "slack.post_blocked", provider: "slack", gate: "auto", description: "Gusto unreadable: nothing submitted" },
  ],
};
