// Container entry point for one AgentCore runtime. WORKFLOW picks which.
//
//   WORKFLOW=support-escalation node dist/main.mjs
//
// Storage: DYNAMODB_TABLE (AgentCore) › STATE_FILE (local, survives restarts) › memory.
// Secrets: SECRET_ARN (Secrets Manager JSON, merged into env at boot) or plain env.
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { ClaudeDrafter, templateDrafter } from "./kit/drafter";
import { Engine } from "./kit/engine";
import {readControlConfig} from "./kit/looplabs-control";
import { createLogger } from "./kit/log";
import { createAgentServer } from "./kit/server";
import { DynamoStore, FileStore, type KvStore, MemoryStore } from "./kit/store";
import { loadWorkflow } from "./kit/load";
import { endpointsFromEnv, providerFactory } from "./providers";

const workflowId = process.env.WORKFLOW ?? "";
const workflow = await loadWorkflow(workflowId);
if (!workflow) {
  console.error(`WORKFLOW must name a file in src/workflows/ (got "${workflowId}")`);
  process.exit(2);
}

if (process.env.SECRET_ARN) {
  const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.SECRET_ARN }));
  for (const [k, v] of Object.entries(JSON.parse(out.SecretString ?? "{}") as Record<string, string>)) process.env[k] ??= v;
}

const log = createLogger({ service: "acme-ops", workflow: workflow.id, org: workflow.org, team: workflow.team });
const store: KvStore = process.env.DYNAMODB_TABLE
  ? new DynamoStore(process.env.DYNAMODB_TABLE)
  : process.env.STATE_FILE
    ? new FileStore(process.env.STATE_FILE)
    : new MemoryStore();
const endpoints = endpointsFromEnv();

const control=readControlConfig(process.env);
if(control&&workflow.id!=="product-cancellation")throw Error("LoopLabs adapter is scoped to product cancellation");
const engine = new Engine(workflow, {
  control,controlSink:(event)=>console.log(JSON.stringify(event)),
  store,
  providers: providerFactory(endpoints),
  drafter: process.env.ANTHROPIC_API_KEY ? new ClaudeDrafter(process.env.ANTHROPIC_API_KEY, log) : templateDrafter,
  log,
  approvers: (process.env.APPROVER_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  approvalTtlMs: Number(process.env.APPROVAL_TTL_HOURS ?? 24) * 3_600_000,
});

const server = createAgentServer(engine as Engine<unknown>, log, {
  ...(control?{control:{config:control,store}}:{}),
  verifierToken: process.env.FETCHSANDBOX_VERIFIER_TOKEN || undefined,
  defaultCorrelation: process.env.X_FLOW_RUN_ID ? { "x-flow-run-id": process.env.X_FLOW_RUN_ID } : {},
});
const port = Number(process.env.PORT ?? 8080);
server.listen(port, process.env.HOST ?? "0.0.0.0", () =>
  log.info("listening", { port, providers: Object.keys(endpoints), store: store.constructor.name, verifier: !!process.env.FETCHSANDBOX_VERIFIER_TOKEN }),
);

process.on("SIGTERM", () => {
  log.info("SIGTERM: draining");
  server.close();
  Promise.race([engine.idle(), new Promise((r) => setTimeout(r, 20_000))]).finally(() => process.exit(0));
});
