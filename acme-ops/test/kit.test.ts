// Engine and AgentCore HTTP contract, independent of any real workflow: a
// two-action toy workflow (one auto Slack post, one approval-gated post)
// exercises every run-level guarantee the workflows rely on.
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadWorkflow } from "../src/kit/load";
import { silentLogger } from "../src/kit/log";
import { createAgentServer } from "../src/kit/server";
import { FileStore } from "../src/kit/store";
import type { WorkflowDef } from "../src/kit/types";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

let agentRuns = 0;
let planCrashes = 0;

const Input = z.object({ channel: z.string().regex(/^C\w+$/), approvers: z.array(z.string()).optional() });
type Input = z.infer<typeof Input>;

const toy: WorkflowDef<Input> = {
  id: "toy",
  title: "Toy",
  org: "Test",
  team: "kit",
  description: "Kit test workflow",
  input: Input,
  agents: [
    {
      name: "counter",
      needs: [],
      async run() {
        agentRuns++;
        return { summary: "counted", data: { n: 1 } };
      },
    },
  ],
  plan({ input }) {
    if (planCrashes > 0) {
      planCrashes--;
      throw new Error("container died");
    }
    return [
      {
        id: "slack.auto",
        kind: "slack.post",
        provider: "slack",
        agent: "counter",
        gate: "auto",
        summary: { channel: input.channel },
        async execute({ providers }) {
          const m = await providers.slack!.postMessage(input.channel, "auto");
          return { ref: m.ts };
        },
      },
      {
        id: "slack.gated",
        kind: "slack.post",
        provider: "slack",
        agent: "counter",
        gate: "approval",
        summary: { channel: input.channel },
        async execute({ providers }) {
          const m = await providers.slack!.postMessage(input.channel, "gated");
          return { ref: m.ts };
        },
      },
    ];
  },
  output: () => ({ ok: true }),
  catalog: [
    { kind: "slack.post", provider: "slack", gate: "auto", description: "auto post" },
    { kind: "slack.post", provider: "slack", gate: "approval", description: "gated post" },
  ],
};

const input = { channel: "C0SUPPORT1", approvers: ["U_LEAD"] };
const start = (runId: string) => ({ action: "start" as const, runId, input, requestedBy: { userId: "U1" } });
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const texts = (w: World) => w.state.slack.messages.map((m: any) => m.text);

let w: World;
beforeEach(async () => {
  w = await startWorld();
  agentRuns = 0;
  planCrashes = 0;
});
afterEach(() => w.close());

describe("engine", () => {
  it("duplicate and concurrent starts create one run and one side effect", async () => {
    const e = w.engine(toy, { now: () => NOW });
    const replies = await Promise.all(Array.from({ length: 5 }, () => e.handle(start("r1"))));
    await e.idle();
    expect(replies.filter((r) => r.body.duplicate === false)).toHaveLength(1);
    expect(texts(w)).toEqual(["auto"]);
    expect((await e.handle({ action: "status", runId: "r1" })).body.duplicateStarts).toBe(4);
  });

  it("gated actions wait for a named approver; one decision wins", async () => {
    const e = w.engine(toy, { now: () => NOW });
    const parked = await e.handle(start("r2"));
    expect(parked.body).toMatchObject({ phase: "AWAITING_APPROVAL", outcome: "ok" });
    expect(action(parked.body, "slack.gated").status).toBe("pending_approval");

    const stranger = await e.handle({ action: "decide", runId: "r2", decision: "approve", userId: "U_X" });
    expect(stranger.status).toBe(403);
    const ok = await e.handle({ action: "decide", runId: "r2", decision: "approve", userId: "U_LEAD" });
    expect(ok.body).toMatchObject({ result: "recorded", phase: "DONE" });
    const again = await e.handle({ action: "decide", runId: "r2", decision: "approve", userId: "U_LEAD" });
    expect(again.body.result).toBe("already_decided");
    expect(texts(w)).toEqual(["auto", "gated"]);
  });

  it("reject, cancel and expiry never apply the gated action", async () => {
    let t = NOW;
    const e = w.engine(toy, { now: () => t, approvalTtlMs: 1000 });
    await e.handle(start("rej"));
    expect((await e.handle({ action: "decide", runId: "rej", decision: "reject", userId: "U_LEAD" })).body.phase).toBe("REJECTED");
    await e.handle(start("can"));
    expect((await e.handle({ action: "cancel", runId: "can", userId: "U1" })).body).toMatchObject({ result: "cancelled", phase: "CANCELLED" });
    expect((await e.handle({ action: "decide", runId: "can", decision: "approve", userId: "U_LEAD" })).body.result).toBe("closed");
    await e.handle(start("exp"));
    t += 5000;
    expect((await e.handle({ action: "decide", runId: "exp", decision: "approve", userId: "U_LEAD" })).body).toMatchObject({ result: "expired", phase: "EXPIRED" });
    expect(texts(w)).not.toContain("gated");
  });

  it("resume retries only a failed effect", async () => {
    w.faults.push({ method: "POST", path: /chat\.postMessage$/, status: 503, body: {}, times: 1 });
    const e = w.engine(toy, { now: () => NOW });
    const first = await e.handle(start("r3"));
    expect(action(first.body, "slack.auto")).toMatchObject({ status: "failed", errorCode: "slack:http_503" });
    expect(first.body.outcome).toBe("partial");
    const resumed = await e.handle({ action: "resume", runId: "r3" });
    expect(resumed.body).toMatchObject({ result: "resumed", outcome: "ok" });
    expect(action(resumed.body, "slack.auto")).toMatchObject({ status: "applied", attempts: 2 });
    expect(texts(w)).toEqual(["auto"]);
  });

  it("an interrupted run resumes from its checkpoint without re-running agents", async () => {
    planCrashes = 1;
    let t = NOW;
    const e = w.engine(toy, { now: () => t });
    const first = await e.handle(start("r4"));
    expect(first.body).toMatchObject({ phase: "RUNNING", lastError: expect.stringContaining("container died") });
    t += 120_000;
    const { body } = await e.handle({ action: "resume", runId: "r4" });
    expect(body).toMatchObject({ result: "resumed", phase: "AWAITING_APPROVAL" });
    expect(agentRuns).toBe(1);
  });

  it("a restarted container finishes a parked run from the state file", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "acme-kit-")), "state.json");
    await w.engine(toy, { store: new FileStore(file), now: () => NOW }).handle(start("r5"));
    const { body } = await w.engine(toy, { store: new FileStore(file), now: () => NOW }).handle({ action: "decide", runId: "r5", decision: "approve", userId: "U_LEAD" });
    expect(body.phase).toBe("DONE");
    expect(texts(w)).toEqual(["auto", "gated"]);
  });

  it("rejects invalid input with readable issues and describes itself", async () => {
    const e = w.engine(toy);
    const bad = await e.handle({ action: "start", input: { channel: "general" }, requestedBy: { userId: "U1" } });
    expect(bad.status).toBe(400);
    expect((bad.body.issues as string[]).join(" ")).toMatch(/channel/);
    const d = await e.handle({ action: "describe" });
    expect(d.body).toMatchObject({ workflow: "toy", org: "Test", team: "kit" });
  });
});

describe("AgentCore HTTP contract", () => {
  async function serve(verifierToken?: string) {
    const server = createAgentServer(w.engine(toy, { now: () => NOW }) as any, silentLogger, { verifierToken });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  it("serves /ping, /invocations, correlation headers and bearer-protected verifier reads", async () => {
    const { server, base } = await serve("vtok");
    try {
      expect(await (await fetch(`${base}/ping`)).json()).toMatchObject({ status: "Healthy" });
      expect((await fetch(`${base}/invocations`, { method: "POST", body: "{nope" })).status).toBe(400);
      expect((await fetch(`${base}/invocations`, { method: "POST", body: JSON.stringify({ action: "explode" }) })).status).toBe(400);
      const res = await fetch(`${base}/invocations`, {
        method: "POST",
        headers: { "x-flow-run-id": "flow-xyz" },
        body: JSON.stringify({ ...start("h1"), labels: { fs_run: "vr_1", fs_case: "baseline" } }),
      });
      expect(res.status).toBe(200);
      expect(w.requests.every((r) => r.headers["x-flow-run-id"] === "flow-xyz")).toBe(true);

      const path = `${base}/verify/runs/vr_1/cases/baseline/runs`;
      expect((await fetch(path)).status).toBe(401);
      const view: any = await (await fetch(path, { headers: { authorization: "Bearer vtok" } })).json();
      expect(view.runs).toHaveLength(1);
      const other: any = await (await fetch(`${base}/verify/runs/vr_1/cases/other/runs`, { headers: { authorization: "Bearer vtok" } })).json();
      expect(other.runs).toHaveLength(0);
      const rt: any = await (await fetch(`${base}/verify/runtime`, { headers: { authorization: "Bearer vtok" } })).json();
      expect(rt).toMatchObject({ workflow: "toy", instance_id: expect.any(String) });
    } finally {
      server.close();
    }
  });

  it("has no verifier routes without a verifier token", async () => {
    const { server, base } = await serve();
    try {
      expect((await fetch(`${base}/verify/runs/a/cases/b/runs`, { headers: { authorization: "Bearer " } })).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe("workflow loader", () => {
  it("refuses ids that aren't a workflow file", async () => {
    for (const id of ["", "shared", "../kit/engine", "Nope", "no-such-workflow"]) expect(await loadWorkflow(id)).toBeUndefined();
  });
});
