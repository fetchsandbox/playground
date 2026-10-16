import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "../src/lib/log";
import { sleep } from "../src/lib/retry";
import { fakeWorld } from "../src/local/fake-deps";
import { ScriptedLlm, defaultScript } from "../src/local/scripted-llm";
import { createAgentServer } from "../src/server";
import { Engine } from "../src/workflow/engine";

// The AgentCore Runtime HTTP contract, exercised over a real socket.
let release!: () => void;
const gate = new Promise<void>((r) => (release = r));
const llm = new ScriptedLlm({ ...defaultScript, intake: async (p) => (await gate, defaultScript.intake!(p)) });
const engine = new Engine({ ...fakeWorld({ llm }).deps }, { stepBackoffMs: 5 });
const server = createAgentServer(engine, silentLogger);
let base = "";

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const invoke = (body: unknown) => fetch(`${base}/invocations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ping = async () => (await (await fetch(`${base}/ping`)).json()) as { status: string; time_of_last_update: number };

describe("AgentCore HTTP contract", () => {
  it("GET /ping is Healthy when idle", async () => {
    expect((await ping()).status).toBe("Healthy");
  });

  it("rejects malformed commands with 400 and a reason", async () => {
    const res = await invoke({ action: "start", requestText: "" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { issues: string[] }).issues.join()).toMatch(/requestText|requestedBy/);
  });

  it("start returns immediately; /ping says HealthyBusy until the background run parks", async () => {
    const res = await invoke({ action: "start", runId: "srv-1", requestText: "quote 5 pro seats for a@b.co", requestedBy: { userId: "U1" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { phase: string }).phase).toBe("RECEIVED");
    expect((await ping()).status).toBe("HealthyBusy"); // keeps the session alive past the idle timeout

    release();
    await engine.idle();
    expect((await ping()).status).toBe("Healthy");
    const status = (await (await invoke({ action: "status", runId: "srv-1" })).json()) as { phase: string };
    expect(status.phase).toBe("AWAITING_APPROVAL");
  });

  it("time_of_last_update only moves when the status changes", async () => {
    const a = await ping();
    await sleep(1100);
    const b = await ping();
    expect(b.time_of_last_update).toBe(a.time_of_last_update);
  });
});
