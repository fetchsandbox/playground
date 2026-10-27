import { z } from "zod";
import { FatalError, SkipAction } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { Approvers, ChannelId, Email, messageId, out, shortHash } from "./shared";

// People Operations · people-ops.
// Trigger: HR records a termination. Final pay has a legal deadline that
// depends on the work state and on who ended the employment (California:
// the same day for a dismissal), so the workflow is built around time:
//   - the termination is filed in payroll at once;
//   - HR may rescind until the last day; a rescission compensates (undoes) the
//     termination already filed, and nothing else happens;
//   - the final off-cycle payroll waits for a payroll manager's approval, but
//     only until shortly before the legal deadline: then it is paid anyway
//     (the law wins over the approval);
//   - access is removed at the end of the last day (WorkOS, GitHub) and the
//     removal is verified; equipment return labels are bought; a benefits
//     continuation notice is drafted.
// A termination entered after the deadline already passed is escalated.

/** Final-pay timing by work state. "same_day": on the last day; "hours": within N hours; "next_payday": by the next regular payday. */
export const FINAL_PAY: Record<string, { involuntary: Rule; voluntary: Rule }> = {
  CA: { involuntary: { kind: "same_day" }, voluntary: { kind: "hours", hours: 72 } },
  CO: { involuntary: { kind: "same_day" }, voluntary: { kind: "next_payday" } },
  MA: { involuntary: { kind: "same_day" }, voluntary: { kind: "next_payday" } },
  NY: { involuntary: { kind: "next_payday" }, voluntary: { kind: "next_payday" } },
  TX: { involuntary: { kind: "hours", hours: 6 * 24 }, voluntary: { kind: "next_payday" } },
  WA: { involuntary: { kind: "next_payday" }, voluntary: { kind: "next_payday" } },
};
type Rule = { kind: "same_day" } | { kind: "hours"; hours: number } | { kind: "next_payday" };
/** States not in the table use the most common rule; legal must confirm before go-live. */
const DEFAULT_RULE: Rule = { kind: "next_payday" };

export const POLICY = {
  /** Pay this long before the legal deadline if no approval has come. */
  safetyMarginHours: 4,
  benefitsNoticeDays: 14,
} as const;

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Input = z.object({
  terminationId: z.string().regex(/^TERM-[\w-]{3,40}$/, "termination id like TERM-2026-0042"),
  employee: z.object({
    gustoId: z.string().regex(/^[\w-]{3,64}$/),
    email: Email,
    personalEmail: Email,
    workState: z.string().regex(/^[A-Z]{2}$/),
    githubLogin: z.string().regex(/^[\w-]{1,39}$/).optional(),
    homeAddress: z.object({ street1: z.string(), city: z.string(), state: z.string(), zip: z.string(), country: z.string().default("US") }).optional(),
  }),
  type: z.enum(["voluntary", "involuntary"]),
  lastDay: DateOnly,
  /** The employee's next regular payday after the last day. */
  nextRegularPayday: DateOnly,
  workosOrganizations: z.array(z.string().regex(/^[\w-]{3,64}$/)).max(20).default([]),
  githubOrg: z.string().regex(/^[\w-]{1,39}$/).optional(),
  equipment: z.array(z.object({ asset: z.string().max(60), weightOz: z.number().positive().max(1_000) })).max(10).default([]),
  /** HR users who may rescind. */
  hr: z.array(z.string().min(1)).min(1).max(20),
  hrChannel: ChannelId,
  hrWorkspace: z.string().min(1).default("acme-people"),
  /** Payroll managers who approve the final payroll. */
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

/** The legal final-pay deadline, as an ISO instant (end of that day, UTC). Pure. */
export function finalPayDeadline(input: Pick<Input, "employee" | "type" | "lastDay" | "nextRegularPayday">): { due: string; rule: string } {
  const rule = FINAL_PAY[input.employee.workState]?.[input.type] ?? DEFAULT_RULE;
  const endOf = (d: string) => `${d}T23:59:00.000Z`;
  if (rule.kind === "same_day") return { due: endOf(input.lastDay), rule: `${input.employee.workState} ${input.type}: on the last day` };
  if (rule.kind === "hours") return { due: new Date(Date.parse(endOf(input.lastDay)) + rule.hours * 3_600_000).toISOString(), rule: `${input.employee.workState} ${input.type}: within ${rule.hours} hours` };
  return { due: endOf(input.nextRegularPayday), rule: `${input.employee.workState} ${input.type}: by the next regular payday` };
}

export interface Access {
  workos: { id: string; organizationId: string; role: string }[];
  github: { org: string; login: string } | null;
}

export const employeeOffboarding: WorkflowDef<Input> = {
  id: "employee-offboarding",
  title: "Employee offboarding with final pay",
  org: "People Operations",
  team: "people-ops",
  description:
    "Offboard an employee on time: file the termination in payroll, pay final wages by the work state's legal deadline (approval, but the law wins), remove access at the end of the last day and verify it, buy equipment return labels, draft the benefits notice; an HR rescission undoes the filed termination.",
  input: Input,
  audit: true,
  tickEvery: "rate(15 minutes)",
  agents: [
    {
      name: "payroll-record",
      needs: ["gusto"],
      async run({ input, providers }) {
        const terms = await providers.gusto!.listTerminations(input.employee.gustoId);
        return { summary: `${terms.length} termination(s) on file`, data: { existing: terms.map((t) => t.effective_date) } };
      },
    },
    {
      name: "access-inventory",
      needs: ["workos"],
      async run({ input, providers }) {
        const wo = providers.workos!;
        const user = await wo.findUserByEmail(input.employee.email);
        const workos = user ? (await wo.listMemberships(user.id)).filter((m) => m.status !== "inactive" && (!input.workosOrganizations.length || input.workosOrganizations.includes(m.organization_id))).map((m) => ({ id: m.id, organizationId: m.organization_id, role: m.role?.slug ?? "member" })) : [];
        let github: Access["github"] = null;
        if (input.githubOrg && input.employee.githubLogin && providers.github) {
          if (await providers.github.getOrgMembership(input.githubOrg, input.employee.githubLogin)) github = { org: input.githubOrg, login: input.employee.githubLogin };
        }
        return { summary: `${workos.length} WorkOS membership(s)${github ? ", GitHub member" : ""}`, data: { workos, github } satisfies Access };
      },
    },
  ],

  compose: {
    name: "offboarding-plan",
    async run({ input, startedAt }, results) {
      const d = finalPayDeadline(input);
      const late = Date.parse(d.due) < startedAt.getTime();
      return { summary: `final pay due ${d.due} (${d.rule})${late ? ", ALREADY LATE" : ""}`, data: { ...d, late, payrollOk: results.status["payroll-record"] === "ok", accessOk: results.status["access-inventory"] === "ok" } };
    },
  },

  plan({ input, startedAt, runId }, results) {
    const p = out<{ due: string; rule: string; late: boolean; payrollOk: boolean; accessOk: boolean }>(results, "offboarding-plan");
    const access = out<Access>(results, "access-inventory");
    if (!p) return [];
    const endOfLastDay = `${input.lastDay}T23:59:00.000Z`;
    const payBy = new Date(Math.max(startedAt.getTime(), Date.parse(p.due) - POLICY.safetyMarginHours * 3_600_000)).toISOString();
    const ids = { terminate: `gusto.terminate:${input.terminationId}`, rescind: `hr.rescind:${input.terminationId}`, stands: `hr.termination_stands:${input.terminationId}`, pay: `gusto.final_payroll:${input.terminationId}`, verify: `access.verify_removed:${input.terminationId}` };
    const who = shortHash(input.employee.email).slice(0, 10);
    const actions: PlannedAction<Input>[] = [];

    actions.push({
      id: ids.terminate,
      kind: "gusto.terminate",
      provider: "gusto",
      agent: "offboarding-plan",
      gate: "auto",
      summary: { employee: who, effective: input.lastDay },
      async execute({ providers }) {
        const existing = (await providers.gusto!.listTerminations(input.employee.gustoId)).find((t) => t.effective_date === input.lastDay);
        if (existing) return { ref: existing.uuid, detail: { reused: true } };
        const t = await providers.gusto!.terminate(input.employee.gustoId, input.lastDay);
        return { ref: t.uuid };
      },
      async compensate({ providers }) {
        await providers.gusto!.cancelTermination(input.employee.gustoId);
        return { ref: input.employee.gustoId };
      },
    });
    // HR can rescind until the end of the last day (approve = rescind).
    actions.push({
      id: ids.rescind,
      kind: "hr.rescind",
      provider: "gusto",
      agent: "offboarding-plan",
      gate: "auto",
      summary: { meaning: "approve = rescind the termination", until: endOfLastDay },
      awaitSignal: { from: input.hr, deadline: endOfLastDay, onDeadline: "reject" },
      async execute({ signal }) {
        return { ref: input.terminationId, detail: { rescindedBy: signal?.by } };
      },
    });
    // The saga's pivot: once the rescission window settles, either the termination stands or everything filed is undone.
    actions.push({
      id: ids.stands,
      kind: "hr.termination_stands",
      provider: "gusto",
      agent: "offboarding-plan",
      gate: "auto",
      summary: { employee: who },
      after: [ids.rescind],
      onFailure: "compensate",
      async execute({ statuses }) {
        if (statuses[ids.rescind] === "applied") throw new FatalError("termination rescinded by HR");
        return { ref: input.terminationId };
      },
    });
    // Final pay: approval by a payroll manager, but paid by the deadline regardless.
    actions.push({
      id: ids.pay,
      kind: "gusto.final_payroll",
      provider: "gusto",
      agent: "offboarding-plan",
      gate: "auto",
      summary: { employee: who, due: p.due, rule: p.rule, payBy, late: p.late },
      awaitSignal: { from: input.approvers ?? [], deadline: payBy, onDeadline: "approve" },
      requires: [ids.terminate],
      async execute({ providers, signal, statuses }) {
        if (statuses[ids.rescind] === "applied") throw new SkipAction("termination rescinded");
        const g = providers.gusto!;
        // One final payroll per termination, even across retries and re-runs.
        const prior = (await g.listPayrolls(input.lastDay)).find((x) => x.off_cycle && x.employee_compensations?.some((c) => c.employee_uuid === input.employee.gustoId));
        if (prior) return { ref: prior.uuid, detail: { reused: true } };
        const checkDate = new Date(Math.min(Date.parse(p.due), Math.max(Date.parse(`${input.lastDay}T00:00:00Z`), Date.now()))).toISOString().slice(0, 10);
        const pr = await g.finalPayroll({ employeeId: input.employee.gustoId, startDate: input.lastDay, endDate: input.lastDay, checkDate });
        return { ref: pr.uuid, detail: { checkDate: pr.check_date, approvedBy: signal?.by, byDeadline: !!signal?.defaulted } };
      },
    });

    // Access ends with the last day.
    const revokeIds: string[] = [];
    for (const m of access?.workos ?? []) {
      const id = `workos.remove:${m.id}`;
      revokeIds.push(id);
      actions.push({
        id,
        kind: "workos.remove",
        provider: "workos",
        agent: "offboarding-plan",
        gate: "auto",
        summary: { organization: m.organizationId, role: m.role },
        waitUntil: endOfLastDay,
        requires: [ids.stands],
        async execute({ providers }) {
          if (!(await providers.workos!.getMembership(m.id).catch(() => undefined))) return { ref: m.id, detail: { alreadyGone: true } };
          await providers.workos!.deleteMembership(m.id);
          return { ref: m.id };
        },
      });
    }
    if (access?.github) {
      const g = access.github;
      const id = `github.remove:${g.org}:${g.login}`;
      revokeIds.push(id);
      actions.push({
        id,
        kind: "github.remove",
        provider: "github",
        agent: "offboarding-plan",
        gate: "auto",
        summary: { org: g.org },
        waitUntil: endOfLastDay,
        requires: [ids.stands],
        async execute({ providers }) {
          if (!(await providers.github!.getOrgMembership(g.org, g.login))) return { ref: g.login, detail: { alreadyGone: true } };
          await providers.github!.removeOrgMember(g.org, g.login);
          return { ref: g.login };
        },
      });
    }
    actions.push({
      id: ids.verify,
      kind: "access.verify_removed",
      provider: "workos",
      agent: "offboarding-plan",
      gate: "auto",
      summary: { systems: revokeIds.length },
      after: revokeIds,
      requires: [ids.stands],
      async execute({ providers, statuses }) {
        const failed = revokeIds.filter((id) => statuses[id] !== "applied");
        const user = await providers.workos!.findUserByEmail(input.employee.email);
        const left = user ? (await providers.workos!.listMemberships(user.id)).filter((m) => m.status !== "inactive" && (!input.workosOrganizations.length || input.workosOrganizations.includes(m.organization_id))) : [];
        const gh = access?.github && providers.github ? await providers.github.getOrgMembership(access.github.org, access.github.login) : undefined;
        if (failed.length || left.length || gh) throw new FatalError(`access still present: ${[...failed, ...left.map((m) => `workos ${m.id}`), ...(gh ? ["github"] : [])].join(", ")}`);
        return { ref: input.terminationId, detail: { verified: revokeIds.length } };
      },
    });

    for (const [i, item] of input.equipment.entries()) {
      if (!input.employee.homeAddress) break;
      actions.push({
        id: `easypost.return_label:${input.terminationId}:${i}`,
        kind: "easypost.return_label",
        provider: "easypost",
        agent: "offboarding-plan",
        gate: "auto",
        summary: { asset: item.asset },
        requires: [ids.stands],
        async execute({ providers }) {
          const a = input.employee.homeAddress!;
          // A return label: from the employee's home to the IT depot.
          const s = await providers.easypost!.createShipment({ reference: `${input.terminationId}-${i}`, to: { name: "ACME IT Returns", street1: "100 Dock Rd", city: "Reno", state: "NV", zip: "89502", country: "US" }, from: { street1: a.street1, city: a.city, state: a.state, zip: a.zip, country: a.country }, parcel: { weight: item.weightOz } });
          const cheapest = [...s.rates].sort((x, y) => Number(x.rate) - Number(y.rate))[0];
          if (!cheapest) throw new FatalError("no return rate");
          const b = await providers.easypost!.buy(s.id, cheapest.id, `return-${input.terminationId}-${i}`);
          return { ref: b.id, detail: { tracking: b.tracking_code } };
        },
      });
    }

    actions.push({
      id: `gmail.benefits_notice:${input.terminationId}`,
      kind: "gmail.benefits_notice",
      provider: "gmail",
      agent: "offboarding-plan",
      gate: "auto",
      summary: { to: "personal email", sent: false },
      requires: [ids.stands],
      async execute({ providers }) {
        const d = await providers.gmail!.createDraft({ to: input.employee.personalEmail, subject: "Your benefits after leaving ACME", body: `Hello,\n\nYour last day at ACME is ${input.lastDay}. Your health coverage continuation (COBRA) election packet will follow from our benefits administrator within ${POLICY.benefitsNoticeDays} days; your final pay is scheduled by ${p.due.slice(0, 10)}.\n\nACME People Operations`, messageId: messageId(runId, `benefits-${input.terminationId}`) });
        return { ref: d.id };
      },
    });

    const head = `${input.terminationId}: ${input.type} termination, last day ${input.lastDay}, ${input.employee.workState}. Final pay due ${p.due} (${p.rule}); paid automatically by ${payBy} without approval.${p.late ? " THE DEADLINE HAS ALREADY PASSED: pay now and tell legal." : ""}`;
    actions.push({
      id: "slack.post_offboarding",
      kind: "slack.post_offboarding",
      provider: "slack",
      agent: "offboarding-plan",
      gate: "auto",
      summary: { channel: input.hrChannel, late: p.late },
      async execute({ providers }) {
        const m = await providers.slack!.postMessage(input.hrChannel, `${p.late ? ":rotating_light:" : ":wave:"} ${head}${!p.payrollOk ? " Payroll could not be read." : ""}${!p.accessOk ? " Access inventory failed: remove access by hand." : ""}`);
        return { ref: m.ts };
      },
    });
    actions.push({
      id: "asana.offboarding_record",
      kind: "asana.offboarding_record",
      provider: "asana",
      agent: "offboarding-plan",
      gate: "auto",
      summary: { termination: input.terminationId },
      after: [ids.pay, ids.verify],
      async execute({ providers, statuses }) {
        const t = await providers.asana!.createTask({ name: `${input.terminationId}: offboarding record`, notes: [head, `Final payroll: ${statuses[ids.pay]}. Access removal verified: ${statuses[ids.verify]}. Rescinded: ${statuses[ids.rescind] === "applied" ? "yes" : "no"}.`].join("\n"), workspace: input.hrWorkspace });
        return { ref: t.gid };
      },
    });
    return actions;
  },

  output(_ctx, results) {
    const p = out<{ due: string; rule: string; late: boolean }>(results, "offboarding-plan");
    return p ? { finalPayDue: p.due, rule: p.rule, late: p.late } : { mode: "not decided" };
  },

  catalog: [
    { kind: "gusto.terminate", provider: "gusto", gate: "auto", description: "File the termination in payroll (undone if HR rescinds)" },
    { kind: "hr.rescind", provider: "gusto", gate: "auto", description: "Signal: HR rescinds before the end of the last day" },
    { kind: "hr.termination_stands", provider: "gusto", gate: "auto", description: "Saga pivot: a rescission compensates everything filed" },
    { kind: "gusto.final_payroll", provider: "gusto", gate: "auto", description: "Final off-cycle payroll; approval by payroll, paid at the deadline regardless" },
    { kind: "workos.remove", provider: "workos", gate: "auto", description: "Remove a membership at the end of the last day" },
    { kind: "github.remove", provider: "github", gate: "auto", description: "Remove from the GitHub organization at the end of the last day" },
    { kind: "access.verify_removed", provider: "workos", gate: "auto", description: "Re-read every system: no access left" },
    { kind: "easypost.return_label", provider: "easypost", gate: "auto", description: "Equipment return label from the employee's home" },
    { kind: "gmail.benefits_notice", provider: "gmail", gate: "auto", description: "Draft the benefits continuation notice" },
    { kind: "slack.post_offboarding", provider: "slack", gate: "auto", description: "HR channel summary with the final-pay deadline" },
    { kind: "asana.offboarding_record", provider: "asana", gate: "auto", description: "Record once pay and access removal are settled" },
  ],
};
