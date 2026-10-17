import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../src/kit/log";
import { createAgentServer } from "../src/kit/server";
import { FileStore, MemoryStore } from "../src/kit/store";
import { onboardingKickoff } from "../src/workflows/onboarding-kickoff";
import { supportEscalation } from "../src/workflows/support-escalation";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

let w: World;
beforeEach(async () => {
  w = await startWorld();
});
afterEach(() => w.close());

const deal = {
  dealId: "D-1",
  company: "Initech",
  contact: { email: "peter@initech.test", firstname: "Peter" },
  plan: { priceId: "price_pro_monthly", quantity: 3 },
  onboardingChannel: "C0ONBOARD1",
};
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);

describe("engine durability", () => {
  it("a restarted container picks up a parked run from the state file and finishes it", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "acme-")), "state.json");
    const first = w.engine(onboardingKickoff, { store: new FileStore(file), now: () => NOW });
    await first.handle({ action: "start", runId: "r1", input: deal, requestedBy: { userId: "U1" } });

    const second = w.engine(onboardingKickoff, { store: new FileStore(file), now: () => NOW });
    const { body } = await second.handle({ action: "decide", runId: "r1", decision: "approve", userId: "U2" });
    expect(body.phase).toBe("DONE");
    expect(w.state.stripe.subscriptions).toHaveLength(1);
    expect(w.state.hubspot.contacts).toHaveLength(1); // nothing re-applied on the second container
  });

  it("resume retries only the failed effect; applied effects are not repeated", async () => {
    w.faults.push({ method: "POST", path: /chat\.postMessage$/, status: 503, body: {}, times: 1 });
    const e = w.engine(onboardingKickoff, { now: () => NOW });
    const { body } = await e.handle({ action: "start", runId: "r2", input: deal, requestedBy: { userId: "U1" } });
    expect(action(body, "slack.post_handoff")).toMatchObject({ status: "failed", errorCode: "slack:http_503" });
    expect(body).toMatchObject({ phase: "AWAITING_APPROVAL", outcome: "partial" });
    const before = { drafts: w.state.gmail.drafts.length, customers: w.state.stripe.customers.length };

    const resumed = await e.handle({ action: "resume", runId: "r2" });
    expect(resumed.body).toMatchObject({ result: "resumed", phase: "AWAITING_APPROVAL", outcome: "ok" });
    expect(action(resumed.body, "slack.post_handoff")).toMatchObject({ status: "applied", attempts: 2 });
    expect(w.state.slack.messages).toHaveLength(1);
    expect(w.state.gmail.drafts.length).toBe(before.drafts);
    expect(w.state.stripe.customers.length).toBe(before.customers);
  });

  it("a run interrupted mid-flight resumes from its checkpoint without re-running agents", async () => {
    let crashes = 1;
    const flaky = {
      ...onboardingKickoff,
      plan: (ctx: any, r: any) => {
        if (crashes-- > 0) throw new Error("container died");
        return onboardingKickoff.plan(ctx, r);
      },
    };
    let t = NOW;
    const e = w.engine(flaky, { now: () => t });
    const first = await e.handle({ action: "start", runId: "r3", input: deal, requestedBy: { userId: "U1" } });
    expect(first.body).toMatchObject({ phase: "RUNNING", lastError: expect.stringContaining("container died") });
    const priceReads = w.requests.filter((r) => r.path.startsWith("/v1/prices/")).length;

    t += 120_000;
    const { body } = await e.handle({ action: "resume", runId: "r3" });
    expect(body).toMatchObject({ result: "resumed", phase: "AWAITING_APPROVAL" });
    expect(w.requests.filter((r) => r.path.startsWith("/v1/prices/")).length).toBe(priceReads);
  });

  it("cancel while awaiting approval skips the gated actions", async () => {
    const e = w.engine(onboardingKickoff, { now: () => NOW });
    await e.handle({ action: "start", runId: "r4", input: deal, requestedBy: { userId: "U1" } });
    const { body } = await e.handle({ action: "cancel", runId: "r4", userId: "U1" });
    expect(body).toMatchObject({ result: "cancelled", phase: "CANCELLED" });
    expect(action(body, "stripe.create_subscription").status).toBe("skipped");
    const late = await e.handle({ action: "decide", runId: "r4", decision: "approve", userId: "U1" });
    expect(late.body.result).toBe("closed");
    expect(w.state.stripe.subscriptions).toHaveLength(0);
  });

  it("approvals expire", async () => {
    let t = NOW;
    const e = w.engine(onboardingKickoff, { now: () => t, approvalTtlMs: 1000 });
    await e.handle({ action: "start", runId: "r5", input: deal, requestedBy: { userId: "U1" } });
    t += 5000;
    const { body } = await e.handle({ action: "decide", runId: "r5", decision: "approve", userId: "U1" });
    expect(body).toMatchObject({ result: "expired", phase: "EXPIRED" });
    expect(w.state.stripe.subscriptions).toHaveLength(0);
  });

  it("describe exposes owner, agents and the gated action catalogue", async () => {
    const e = w.engine(onboardingKickoff);
    const { body } = await e.handle({ action: "describe" });
    expect(body).toMatchObject({ workflow: "onboarding-kickoff", org: "Sales", team: "sales-ops" });
    expect((body.actions as any[]).filter((a) => a.gate === "approval").map((a) => a.kind)).toEqual(["stripe.create_subscription", "calendar.kickoff_invite"]);
  });
});

describe("AgentCore HTTP contract", () => {
  it("serves /ping, /invocations and bearer-protected verifier reads", async () => {
    const e = w.engine(supportEscalation as any, { now: () => NOW });
    const server = createAgentServer(e, silentLogger, { verifierToken: "vtok" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await (await fetch(`${base}/ping`)).json()).toMatchObject({ status: "Healthy" });
      expect((await fetch(`${base}/invocations`, { method: "POST", body: "{nope" })).status).toBe(400);
      expect((await fetch(`${base}/invocations`, { method: "POST", body: JSON.stringify({ action: "explode" }) })).status).toBe(400);

      const start = await fetch(`${base}/invocations`, {
        method: "POST",
        headers: { "x-flow-run-id": "flow-xyz" },
        body: JSON.stringify({
          action: "start",
          runId: "t1",
          labels: { fs_run: "vr_1", fs_case: "baseline" },
          requestedBy: { userId: "U1" },
          input: { ticket: { id: 1, subject: "Billing question", requester: { email: "dev@startupxyz.io" } }, escalationChannel: "C0SUPPORT1" },
        }),
      });
      expect(start.status).toBe(200);
      expect(w.requests.every((r) => r.headers["x-flow-run-id"] === "flow-xyz")).toBe(true);

      expect((await fetch(`${base}/verify/runs/vr_1/cases/baseline/runs`)).status).toBe(401);
      const view: any = await (await fetch(`${base}/verify/runs/vr_1/cases/baseline/runs`, { headers: { authorization: "Bearer vtok" } })).json();
      expect(view.runs).toHaveLength(1);
      expect(view.runs[0]).toMatchObject({ runId: "t1", workflow: "support-escalation" });
      const empty: any = await (await fetch(`${base}/verify/runs/vr_1/cases/other/runs`, { headers: { authorization: "Bearer vtok" } })).json();
      expect(empty.runs).toHaveLength(0);
    } finally {
      server.close();
    }
  });

  it("verifier routes do not exist without a verifier token", async () => {
    const e = w.engine(supportEscalation as any);
    const server = createAgentServer(e, silentLogger, {});
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/verify/runs/a/cases/b/runs`, { headers: { authorization: "Bearer " } })).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
