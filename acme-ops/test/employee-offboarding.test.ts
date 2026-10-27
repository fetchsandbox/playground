import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { employeeOffboarding, finalPayDeadline } from "../src/workflows/employee-offboarding";
import { startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const user = { userId: "U_HR" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const T0 = Date.parse("2026-11-02T15:00:00Z"); // a Monday afternoon; last day is Friday 6 Nov

const input = (over: object = {}) => ({
  terminationId: "TERM-2026-0042",
  employee: { gustoId: "emp_ana", email: "ana@acme.example", personalEmail: "ana.home@example.com", workState: "NY", githubLogin: "ana-dev", homeAddress: { street1: "1 Elm St", city: "Albany", state: "NY", zip: "12207", country: "US" } },
  type: "voluntary",
  lastDay: "2026-11-06",
  nextRegularPayday: "2026-11-13",
  githubOrg: "acme",
  equipment: [{ asset: "MacBook Pro 14", weightOz: 80 }],
  hr: ["U_HR", "U_HRBP"],
  hrChannel: "C0SUPPORT1",
  approvers: ["U_PAYROLL"],
  ...over,
});

describe("final-pay deadline", () => {
  const d = (workState: string, type: "voluntary" | "involuntary") => finalPayDeadline({ employee: { workState } as any, type, lastDay: "2026-11-06", nextRegularPayday: "2026-11-13" });
  it("follows the work state and who ended the employment", () => {
    expect(d("CA", "involuntary")).toEqual({ due: "2026-11-06T23:59:00.000Z", rule: "CA involuntary: on the last day" });
    expect(d("CA", "voluntary").due).toBe("2026-11-09T23:59:00.000Z");
    expect(d("TX", "involuntary").due).toBe("2026-11-12T23:59:00.000Z");
    expect(d("NY", "voluntary").due).toBe("2026-11-13T23:59:00.000Z");
    expect(d("OR", "voluntary").rule).toBe("OR voluntary: by the next regular payday");
  });
});

describe("employee-offboarding runs", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
    w.state.workos.users.push({ id: "u_ana", email: "ana@acme.example" });
    w.state.workos.memberships.push({ id: "om_ana", user_id: "u_ana", organization_id: "org_acme", role: { slug: "admin" }, status: "active" });
    w.state.github.members.push({ org: "acme", login: "ana-dev", id: 7, role: "member" });
  });
  afterEach(() => w.close());

  it("files the termination now, pays on approval, removes access at the end of the last day and verifies it", async () => {
    const clock = { t: T0 };
    const e = w.engine(employeeOffboarding, { now: () => clock.t });
    const r = await e.handle({ action: "start", runId: "off", input: input(), requestedBy: user });
    expect(r.body).toMatchObject({ phase: "WAITING", output: { finalPayDue: "2026-11-13T23:59:00.000Z", late: false } });
    expect(w.state.gusto.terminations).toEqual([expect.objectContaining({ employee_uuid: "emp_ana", effective_date: "2026-11-06", active: true })]);
    // Labels and the benefits notice wait until the termination stands (no rescission by the end of the last day).
    expect(w.state.easypost.shipments).toHaveLength(0);
    expect(w.state.gmail.drafts).toHaveLength(0);

    await e.handle({ action: "signal", runId: "off", actionId: "gusto.final_payroll:TERM-2026-0042", value: "approve", userId: "U_PAYROLL" });
    expect(w.state.gusto.payrolls).toEqual([expect.objectContaining({ processed: true, off_cycle_reason: "Dismissed employee" })]);
    // Access is still there before the end of the last day.
    expect(w.state.workos.memberships).toHaveLength(1);

    clock.t = Date.parse("2026-11-07T00:00:00Z");
    await e.handle({ action: "tick" });
    const s = (await e.handle({ action: "status", runId: "off" })).body;
    expect(w.state.workos.memberships).toHaveLength(0);
    expect(w.state.github.members).toHaveLength(0);
    expect(w.state.easypost.shipments.filter((x) => x.tracking_code)).toHaveLength(1);
    expect(w.state.gmail.drafts).toHaveLength(1);
    expect(action(s, "access.verify_removed:TERM-2026-0042")).toMatchObject({ status: "applied", detail: { verified: 2 } });
    expect(s).toMatchObject({ phase: "DONE", outcome: "ok" });
    expect((await e.handle({ action: "evidence", runId: "off" })).body.verified).toBe(true);
  });

  it("without approval the final payroll still runs before the legal deadline (California dismissal: same day)", async () => {
    const clock = { t: T0 };
    const e = w.engine(employeeOffboarding, { now: () => clock.t });
    await e.handle({ action: "start", runId: "off", input: input({ type: "involuntary", employee: { ...input().employee, workState: "CA" } }), requestedBy: user });
    expect(w.state.gusto.payrolls).toHaveLength(0);
    clock.t = Date.parse("2026-11-06T20:00:00Z"); // past 19:59, four hours before the deadline
    await e.handle({ action: "tick" });
    const s = (await e.handle({ action: "status", runId: "off" })).body;
    expect(action(s, "gusto.final_payroll:TERM-2026-0042")).toMatchObject({ status: "applied", signal: { by: "deadline", defaulted: true }, detail: { byDeadline: true } });
  });

  it("an HR rescission before the last day undoes the filed termination and nothing else happens", async () => {
    const clock = { t: T0 };
    const e = w.engine(employeeOffboarding, { now: () => clock.t });
    await e.handle({ action: "start", runId: "off", input: input({ equipment: [] }), requestedBy: user });
    const r = await e.handle({ action: "signal", runId: "off", actionId: "hr.rescind:TERM-2026-0042", value: "approve", userId: "U_HRBP" });
    expect(r.body).toMatchObject({ phase: "DONE", outcome: "compensated" });
    expect(action(r.body, "gusto.terminate:TERM-2026-0042")).toMatchObject({ status: "compensated", compensation: { status: "applied" } });
    expect(w.state.gusto.terminations[0].active).toBe(false);
    expect(action(r.body, "workos.remove:om_ana").status).toBe("skipped");
    clock.t = Date.parse("2026-11-08T00:00:00Z");
    await e.handle({ action: "tick" });
    expect(w.state.workos.memberships).toHaveLength(1);
    expect(w.state.gusto.payrolls).toHaveLength(0);
  });

  it("a termination entered after the deadline passed is flagged late and escalated", async () => {
    const e = w.engine(employeeOffboarding, { now: () => Date.parse("2026-11-20T09:00:00Z") });
    const r = await e.handle({ action: "start", runId: "off", input: input(), requestedBy: user });
    expect(r.body.output).toMatchObject({ late: true });
    expect(w.state.slack.messages[0].text).toContain("THE DEADLINE HAS ALREADY PASSED");
  });

  it("access that can't be removed fails verification; the record still lands", async () => {
    w.faults.push({ method: "DELETE", path: /^\/orgs\/acme\/memberships\/ana-dev$/, status: 403, body: { message: "Must have admin rights" } });
    const clock = { t: T0 };
    const e = w.engine(employeeOffboarding, { now: () => clock.t });
    await e.handle({ action: "start", runId: "off", input: input({ equipment: [] }), requestedBy: user });
    await e.handle({ action: "signal", runId: "off", actionId: "gusto.final_payroll:TERM-2026-0042", value: "approve", userId: "U_PAYROLL" });
    clock.t = Date.parse("2026-11-07T00:00:00Z");
    await e.handle({ action: "tick" });
    const s = (await e.handle({ action: "status", runId: "off" })).body;
    expect(action(s, "access.verify_removed:TERM-2026-0042")).toMatchObject({ status: "failed", error: expect.stringContaining("github.remove:acme:ana-dev") });
    expect(action(s, "asana.offboarding_record").status).toBe("applied");
  });
});
