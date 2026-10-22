import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changeManagementGate, decideGate, type ChangeFacts, type OpsFacts } from "../src/workflows/change-management-gate";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const MIN = 60_000;
const user = { userId: "U_DEPLOY_BOT" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const input = (over: object = {}) => ({
  changeId: "CHG-2026-0042",
  repo: "acme/checkout",
  pullRequest: 88,
  service: { name: "checkout", pagerdutyServiceId: "PSVC123", monitorIds: [101], errorRateQuery: "sum:checkout.errors{*}.as_rate()" },
  type: "standard",
  opsChannel: "C0CSOPS001",
  approvers: ["U_CAB_1", "dev-alice"],
  ...over,
});

describe("gate", () => {
  const parsed = (o: object = {}) => changeManagementGate.input.parse(input(o));
  const change = (o: Partial<ChangeFacts> = {}): ChangeFacts => ({ merged: true, sha: "abc1234", author: "dev-alice", approvingReviewers: ["dev-bob"], failedChecks: [], pendingChecks: [], ...o });
  const ops = (o: Partial<OpsFacts> = {}): OpsFacts => ({ incidents: [], alerting: [], ...o });
  it("standard deploys, normal needs CAB, emergency ships through a freeze or incident but never with red checks", () => {
    expect(decideGate(parsed(), change(), ops(), NOW).mode).toBe("deploy");
    expect(decideGate(parsed({ type: "normal" }), change(), ops(), NOW).mode).toBe("needs_cab");
    const frozen = { freezes: [{ from: new Date(NOW - MIN).toISOString(), to: new Date(NOW + 60 * MIN).toISOString(), reason: "quarter end" }] };
    expect(decideGate(parsed(frozen), change(), ops(), NOW).reasons[0]).toContain("change freeze");
    expect(decideGate(parsed({ ...frozen, type: "emergency" }), change(), ops({ incidents: [{ id: "P1", urgency: "high" }] }), NOW).mode).toBe("emergency");
    expect(decideGate(parsed({ type: "emergency" }), change({ failedChecks: ["unit"] }), ops(), NOW).mode).toBe("blocked");
    expect(decideGate(parsed(), change({ approvingReviewers: ["dev-alice"] }), ops(), NOW).reasons).toEqual(["no approving review from someone other than the author"]);
  });
});

describe("change-management-gate runs", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
    w.state.gh.pulls.push({ repo: "acme/checkout", number: 88, state: "closed", merged: true, merge_commit_sha: "abc1234", head: { sha: "def" }, base: { ref: "main" }, user: { login: "dev-alice" } });
    w.state.gh.reviews.push({ repo: "acme/checkout", number: 88, user: { login: "dev-bob" }, state: "APPROVED" });
    w.state.gh.checkRuns.push({ repo: "acme/checkout", sha: "abc1234", name: "ci", status: "completed", conclusion: "success" });
    w.state.gh.deployments.push({ id: 1, repo: "acme/checkout", sha: "old9999", ref: "old9999", environment: "production", payload: {} });
    w.state.datadog.monitors.push({ id: 101, name: "checkout 5xx", overall_state: "OK" });
  });
  afterEach(() => w.close());

  it("deploys a standard change, watches 15 minutes and marks it healthy", async () => {
    const clock = { t: NOW };
    const e = w.engine(changeManagementGate, { now: () => clock.t });
    const r = await e.handle({ action: "start", runId: "chg", input: input(), requestedBy: user });
    expect(r.body).toMatchObject({ phase: "WAITING", output: { mode: "deploy" } });
    expect(w.state.gh.deployments[0]).toMatchObject({ sha: "abc1234", payload: { change_id: "CHG-2026-0042" } });
    clock.t = NOW + 16 * MIN;
    await e.handle({ action: "tick" });
    const s = (await e.handle({ action: "status", runId: "chg" })).body;
    expect(s).toMatchObject({ phase: "DONE", outcome: "ok" });
    expect(w.state.gh.statuses.map((x) => x.state)).toEqual(["in_progress", "success"]);
  });

  it("a degraded watch window rolls back to what was live before", async () => {
    const clock = { t: NOW };
    const e = w.engine(changeManagementGate, { now: () => clock.t });
    await e.handle({ action: "start", runId: "chg", input: input(), requestedBy: user });
    w.state.datadog.errorRate = 7.5;
    clock.t = NOW + 16 * MIN;
    await e.handle({ action: "tick" });
    const s = (await e.handle({ action: "status", runId: "chg" })).body;
    expect(s).toMatchObject({ phase: "DONE", outcome: "compensated" });
    expect(action(s, "github.deploy:CHG-2026-0042")).toMatchObject({ status: "compensated", compensation: { status: "applied" } });
    expect(w.state.gh.deployments[0]).toMatchObject({ sha: "old9999", payload: { rollback_of: "CHG-2026-0042" } });
    expect(w.state.gh.statuses.map((x) => x.state)).toEqual(["in_progress", "failure"]);
    expect(w.state.slack.messages.at(-1).text).toContain("rolled back to old9999");
  });

  it("a normal change waits for a CAB approver who isn't the author; the watch starts at the deploy", async () => {
    const clock = { t: NOW };
    const e = w.engine(changeManagementGate, { now: () => clock.t });
    await e.handle({ action: "start", runId: "chg", input: input({ type: "normal" }), requestedBy: user });
    expect(w.state.gh.deployments).toHaveLength(1);
    expect((await e.handle({ action: "signal", runId: "chg", actionId: "cab.approve:CHG-2026-0042", value: "approve", userId: "dev-alice" })).status).toBe(403);
    clock.t = NOW + 60 * MIN;
    await e.handle({ action: "signal", runId: "chg", actionId: "cab.approve:CHG-2026-0042", value: "approve", userId: "U_CAB_1" });
    expect(w.state.gh.deployments[0].sha).toBe("abc1234");
    const watch = action((await e.handle({ action: "status", runId: "chg" })).body, "datadog.watch:CHG-2026-0042");
    expect(watch).toMatchObject({ status: "scheduled", waitUntil: new Date(NOW + 75 * MIN).toISOString() });
  });

  it("an open high-urgency incident blocks a standard change", async () => {
    w.state.pagerduty.incidents.push({ id: "Q1", urgency: "high", status: "triggered", service: { id: "PSVC123" } });
    const r = await w.engine(changeManagementGate, { now: () => NOW }).handle({ action: "start", runId: "chg", input: input(), requestedBy: user });
    expect(r.body).toMatchObject({ phase: "DONE", output: { mode: "blocked", reasons: ["open incident(s) on checkout: Q1"] } });
    expect(w.state.gh.deployments).toHaveLength(1);
  });
});
