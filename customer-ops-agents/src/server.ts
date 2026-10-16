import { type IncomingMessage, type Server, createServer } from "node:http";
import { errorMessage } from "./lib/errors";
import type { Logger } from "./lib/log";
import { CommandSchema } from "./workflow/commands";
import type { Engine } from "./workflow/engine";

const MAX_BODY = 1_000_000;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error("request body too large"), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * AgentCore Runtime HTTP contract: POST /invocations and GET /ping on :8080.
 *
 * /ping reports "HealthyBusy" while runs are executing in the background so
 * AgentCore doesn't reclaim the session at the 15-minute idle mark, and
 * "Healthy" otherwise. `time_of_last_update` only moves when the status
 * changes; bumping it on every ping would keep idle sessions alive forever.
 */
export function createAgentServer(engine: Engine, log: Logger): Server {
  let lastStatus = "Healthy";
  let lastChange = Math.floor(Date.now() / 1000);

  return createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url === "/ping") {
        const status = engine.busy ? "HealthyBusy" : "Healthy";
        if (status !== lastStatus) {
          lastStatus = status;
          lastChange = Math.floor(Date.now() / 1000);
        }
        return send(200, { status, time_of_last_update: lastChange });
      }
      if (req.method === "POST" && req.url === "/invocations") {
        let json: unknown;
        try {
          json = JSON.parse(await readBody(req));
        } catch (err) {
          return send((err as { status?: number }).status ?? 400, { error: "body must be a JSON command" });
        }
        const parsed = CommandSchema.safeParse(json);
        if (!parsed.success) return send(400, { error: "invalid command", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
        const session = req.headers["x-amzn-bedrock-agentcore-runtime-session-id"];
        log.info("invocation", { action: parsed.data.action, runId: "runId" in parsed.data ? parsed.data.runId : undefined, session });
        return send(200, await engine.handle(parsed.data));
      }
      send(404, { error: "not found" });
    } catch (err) {
      log.error("invocation failed", { err: errorMessage(err) });
      send(500, { error: errorMessage(err) });
    }
  });
}
