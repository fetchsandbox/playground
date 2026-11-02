import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { silentLogger } from "../src/kit/log";
import { createAgentServer, SNOWFLAKE_FUNCTION_PATH } from "../src/kit/server";
import type { WorkflowDef } from "../src/kit/types";
import { NOW, startWorld } from "./fake-world";

const toy: WorkflowDef<{ n: number }> = {
  id: "toy",
  title: "Toy",
  org: "Test",
  team: "kit",
  description: "Echoes",
  input: z.object({ n: z.number() }),
  agents: [],
  plan: () => [],
  output: ({ input }) => ({ n: input.n }),
  catalog: [],
};

describe("Snowflake service functions", () => {
  it("answers a row batch with one reply per row, in order, invalid rows included", async () => {
    const w = await startWorld();
    const server = createAgentServer(w.engine(toy, { now: () => NOW }) as any, silentLogger, {});
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${SNOWFLAKE_FUNCTION_PATH}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: [[0, { action: "start", runId: "sf-1", input: { n: 7 }, requestedBy: { userId: "SNOWFLAKE_TASK" } }], [1, '{"action":"status","runId":"sf-1"}'], [2, { action: "nope" }], [3, "{not json"]] }),
      });
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: [number, { status: number; body: any }][] };
      expect(data.map((d) => d[0])).toEqual([0, 1, 2, 3]);
      expect(data[0]![1]).toMatchObject({ status: 200, body: { runId: "sf-1", output: { n: 7 } } });
      expect(data[1]![1]).toMatchObject({ status: 200, body: { runId: "sf-1" } });
      expect(data[2]![1].status).toBe(400);
      expect(data[3]![1].status).toBe(400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await w.close();
    }
  });
});
