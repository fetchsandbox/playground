// Container entry point for AgentCore Runtime.
//   LOCAL_FAKES=1 node dist/main.mjs   → same server against in-memory fakes (no AWS, no keys)
import { type Deps, getDeps } from "./deps";
import { createLogger } from "./lib/log";
import { fakeWorld } from "./local/fake-deps";
import { createAgentServer } from "./server";
import { Engine } from "./workflow/engine";

const log = createLogger({ service: "customer-ops-agents" });
const deps: Deps = process.env.LOCAL_FAKES === "1" ? { ...fakeWorld().deps, log } : await getDeps();
const engine = new Engine(deps);
const server = createAgentServer(engine, log);
const port = Number(process.env.PORT ?? 8080);

server.listen(port, "0.0.0.0", () => log.info("listening", { port, fakes: process.env.LOCAL_FAKES === "1" }));

// On shutdown, give in-flight runs a moment to checkpoint. Anything cut off
// is resumed later by `resume`/`sweep` once its lease expires.
process.on("SIGTERM", () => {
  log.info("SIGTERM: draining");
  server.close();
  Promise.race([engine.idle(), new Promise((r) => setTimeout(r, 20_000))]).finally(() => process.exit(0));
});
