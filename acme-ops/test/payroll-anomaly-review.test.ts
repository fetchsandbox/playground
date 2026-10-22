import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payrollAnomalyReview } from "../src/workflows/payroll-anomaly-review";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const user = { userId: "U_PAYROLL_BOT" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const input = (over: object = {}) => ({ reviewId: "PAYREV-2026-10-31", payrollId: "pr_now", preparer: "U_PREP", reviewers: ["U_PREP", "U_CONTROLLER"], payrollChannel: "C0FINANCE1", ...over });
const comp = (u: string, gross: string) => ({ employee_uuid: u, gross_pay: gross, net_pay: String(Number(gross) * 0.7) });
const past = (n: number, date: string, comps: any[]) => ({ uuid: `pr_${n}`, processed: true, off_cycle: false, check_date: date, version: "v1", employee_compensations: comps });

describe("payroll-anomaly-review runs", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
    w.state.gusto.employees.push({ uuid: "e_ana", first_name: "Ana", last_name: "Ruiz" }, { uuid: "e_bo", first_name: "Bo", last_name: "Chen" }, { uuid: "e_cy", first_name: "Cy", last_name: "Dee", terminations: [{ effective_date: "2026-10-01" }] }, { uuid: "e_new", first_name: "Nia", last_name: "New" });
    w.state.gusto.payrolls.push(
      past(1, "2026-09-15", [comp("e_ana", "4000.00"), comp("e_bo", "5000.00"), comp("e_cy", "3000.00")]),
      past(2, "2026-09-30", [comp("e_ana", "4000.00"), comp("e_bo", "5000.00"), comp("e_cy", "3000.00")]),
      past(3, "2026-10-15", [comp("e_ana", "4100.00"), comp("e_bo", "5000.00")]),
    );
  });
  afterEach(() => w.close());
  const current = (comps: any[]) => w.state.gusto.payrolls.push({ uuid: "pr_now", processed: false, off_cycle: false, check_date: "2026-10-31", payroll_deadline: new Date(NOW + 48 * 3_600_000).toISOString(), pay_period: { start_date: "2026-10-16", end_date: "2026-10-31" }, version: "v9", employee_compensations: comps });

  it("a clean payroll is submitted at once", async () => {
    current([comp("e_ana", "4050.00"), comp("e_bo", "5000.00")]);
    const r = await w.engine(payrollAnomalyReview, { now: () => NOW }).handle({ action: "start", runId: "p", input: input(), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "clean", flagged: 0, critical: 0 });
    expect(w.state.gusto.payrolls.find((p: any) => p.uuid === "pr_now").processed).toBe(true);
  });

  it("flags pay after termination, a large raise and an oversized first payroll; a reviewer who didn't prepare it can approve", async () => {
    current([comp("e_ana", "6000.00"), comp("e_bo", "5000.00"), comp("e_cy", "3000.00"), comp("e_new", "20000.00")]);
    const e = w.engine(payrollAnomalyReview, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "p", input: input(), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "review", flagged: 3, critical: 1 });
    expect(w.state.slack.messages[0].text).toMatch(/Ana Ruiz: \$6,000\.00 \(median \$4,000\.00\): gross up 50%/);
    expect(w.state.slack.messages[0].text).toMatch(/Cy Dee: \$3,000\.00 .*paid after termination on 2026-10-01/);
    expect(w.state.slack.messages[0].text).toMatch(/Nia New: \$20,000\.00: first payroll over \$15,000\.00/);
    expect((await e.handle({ action: "signal", runId: "p", actionId: "payroll.review:pr_now", value: "approve", userId: "U_PREP" })).status).toBe(403);
    const d = await e.handle({ action: "signal", runId: "p", actionId: "payroll.review:pr_now", value: "approve", userId: "U_CONTROLLER" });
    expect(action(d.body, "gusto.exclude_flagged:pr_now")).toMatchObject({ status: "skipped" });
    expect(action(d.body, "gusto.submit:pr_now")).toMatchObject({ status: "applied", detail: { excluded: [] } });
  });

  it("no decision two hours before the deadline: the flagged are held back and everyone else is paid on time", async () => {
    current([comp("e_ana", "6000.00"), comp("e_bo", "5000.00")]);
    const clock = { t: NOW };
    const e = w.engine(payrollAnomalyReview, { now: () => clock.t });
    await e.handle({ action: "start", runId: "p", input: input(), requestedBy: user });
    clock.t = NOW + 46 * 3_600_000 + 1;
    await e.handle({ action: "tick" });
    const p = w.state.gusto.payrolls.find((x: any) => x.uuid === "pr_now");
    expect(p.processed).toBe(true);
    expect(p.employee_compensations.find((c: any) => c.employee_uuid === "e_ana").excluded).toBe(true);
    expect(p.employee_compensations.find((c: any) => c.employee_uuid === "e_bo").excluded).toBeFalsy();
    expect(w.state.slack.messages.at(-1).text).toMatch(/1 employee\(s\) held back .*Ana Ruiz/);
  });

  it("a processed payroll is left alone; an unreadable payroll is never submitted", async () => {
    current([comp("e_ana", "4000.00")]);
    w.state.gusto.payrolls.at(-1).processed = true;
    const r = await w.engine(payrollAnomalyReview, { now: () => NOW }).handle({ action: "start", runId: "p", input: input(), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "already_processed" });
    w.faults.push({ method: "GET", path: /\/employees$/, status: 503, body: {} });
    const b = await w.engine(payrollAnomalyReview, { now: () => NOW }).handle({ action: "start", runId: "p2", input: input({ payrollId: "pr_3" }), requestedBy: user });
    expect(b.body.output).toEqual({ mode: "blocked" });
    expect(w.state.slack.messages.at(-1).text).toMatch(/has not been submitted/);
  });
});
