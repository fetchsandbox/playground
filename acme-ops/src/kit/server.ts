import { randomUUID, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type Server, createServer } from "node:http";
import { CommandSchema, type Engine } from "./engine";
import { errorMessage } from "./errors";
import type { Logger } from "./log";
import {controlEnvelope,type ControlConfig} from "./looplabs-control";
import type {KvStore} from "./store";
import { handleStripeWebhook } from "./webhooks";

const MAX_BODY = 1_000_000;

/** Incoming headers that are copied onto every provider call of the run they start. */
const CORRELATION_HEADERS = ["x-flow-run-id"];

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

function bearerOk(req: IncomingMessage, token: string): boolean {
  const got = Buffer.from(String(req.headers.authorization ?? ""));
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface ServerOptions {
  control?: {config:ControlConfig;store:KvStore};
  /**
   * Enables the read-only verifier routes (GET /verify/...), each requiring
   * `Authorization: Bearer <token>`. Unset in production: AgentCore only
   * routes /invocations and /ping anyway.
   */
  verifierToken?: string;
  /** Correlation headers applied when the request carries none (e.g. X_FLOW_RUN_ID). */
  defaultCorrelation?: Record<string, string>;
  /** Signing secret of the Stripe webhook endpoint (whsec_...). Without it, Stripe events are refused. */
  stripeWebhookSecret?: string;
}

const STRIPE_WEBHOOK_PATH = "/webhooks/stripe";

/**
 * AgentCore Runtime HTTP contract: POST /invocations and GET /ping on :8080.
 *
 * /ping answers "HealthyBusy" while a run is executing in the background so
 * AgentCore keeps the session through its 15-minute idle timeout, and
 * "Healthy" otherwise. `time_of_last_update` only moves when the status changes.
 */
export function createAgentServer(engine: Engine<unknown>, log: Logger, opts: ServerOptions = {}): Server {
  let lastStatus = "Healthy";
  let lastChange = Math.floor(Date.now() / 1000);
  // Changes on every process start; lets a verifier prove a real restart happened.
  const instanceId = randomUUID();
  const startedAt = new Date().toISOString();

  return createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const path = (req.url ?? "/").split("?")[0]!;
    const correlationOf = (headers: Record<string, unknown>) => {
      const correlation: Record<string, string> = { ...opts.defaultCorrelation };
      for (const h of CORRELATION_HEADERS) {
        const v = headers[h];
        if (typeof v === "string" && v) correlation[h] = v;
      }
      return correlation;
    };
    const stripeEvent = (raw: string, headers: Record<string, unknown>) =>
      handleStripeWebhook(engine, raw, Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), typeof v === "string" ? v : undefined])), {
        secret: opts.stripeWebhookSecret,
        correlation: correlationOf(Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))),
        log,
      });
    try {
      // Stripe delivers straight to this route (local runs, the FetchSandbox relay)...
      if (req.method === "POST" && path === STRIPE_WEBHOOK_PATH) {
        const reply = await stripeEvent(await readBody(req), req.headers);
        return send(reply.status, reply.body);
      }

      if (req.method === "GET" && path === "/ping") {
        const status = engine.busy ? "HealthyBusy" : "Healthy";
        if (status !== lastStatus) {
          lastStatus = status;
          lastChange = Math.floor(Date.now() / 1000);
        }
        return send(200, { status, time_of_last_update: lastChange });
      }

      if (req.method === "POST" && path === "/invocations") {
        let json: unknown;
        try {
          json = JSON.parse(await readBody(req));
        } catch (err) {
          return send((err as { status?: number }).status ?? 400, { error: "body must be a JSON command" });
        }
        // ...or, on AgentCore (which only routes /invocations), a webhook adapter forwards
        // the untouched request as {method, path, headers, raw_body} and relays the reply.
        const env = json as { method?: unknown; path?: unknown; headers?: unknown; raw_body?: unknown };
        if (env && typeof env === "object" && env.path === STRIPE_WEBHOOK_PATH && env.method === "POST" && typeof env.raw_body === "string" && env.headers && typeof env.headers === "object") {
          const reply = await stripeEvent(env.raw_body, env.headers as Record<string, unknown>);
          return send(200, { status: reply.status, body: Buffer.from(JSON.stringify(reply.body)).toString("base64"), headers: { "content-type": "application/json" } });
        }
        if(opts.control && json && typeof json === "object" && ("raw_body" in json || "path" in json)) return send(200,await controlEnvelope(engine,opts.control.store,opts.control.config,json));
        const parsed = CommandSchema.safeParse(json);
        if (!parsed.success) {
          return send(400, { error: "invalid command", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
        }
        const correlation: Record<string, string> = { ...opts.defaultCorrelation };
        for (const h of CORRELATION_HEADERS) {
          const v = req.headers[h];
          if (typeof v === "string" && v) correlation[h] = v;
        }
        const session = req.headers["x-amzn-bedrock-agentcore-runtime-session-id"];
        log.info("invocation", { action: parsed.data.action, runId: "runId" in parsed.data ? parsed.data.runId : undefined, session });
        const reply = await engine.handle(parsed.data, correlation);
        return send(reply.status, reply.body);
      }

      // Verifier-only, read-only views of saved run state, scoped by the
      // labels the run was started with. Path segments only (no query strings).
      if (req.method === "GET" && opts.verifierToken && path.startsWith("/verify/")) {
        if (!bearerOk(req, opts.verifierToken)) return send(401, { error: "unauthorized" });
        if (path === "/verify/runtime") return send(200, { instance_id: instanceId, workflow: engine.workflow.id, startedAt });
        const m = /^\/verify\/runs\/([^/]+)\/cases\/([^/]+)\/runs$/.exec(path);
        if (m) {
          const runs = await engine.findByLabels({ fs_run: decodeURIComponent(m[1]!), fs_case: decodeURIComponent(m[2]!) });
          return send(200, { runs });
        }
        const one = /^\/verify\/runs\/([^/]+)$/.exec(path);
        if (one) {
          const run = await engine.load(decodeURIComponent(one[1]!));
          return run ? send(200, { runs: [engine.view(run)] }) : send(200, { runs: [] });
        }
      }

      send(404, { error: "not found" });
    } catch (err) {
      log.error("request failed", { path, err: errorMessage(err) });
      send(500, { error: errorMessage(err) });
    }
  });
}
