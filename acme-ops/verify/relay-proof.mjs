#!/usr/bin/env node
/**
 * Prove one acme-ops AgentCore runtime against FetchSandbox twins through the
 * managed relay (manage_tunnel + validate_integration application_workflow_v1).
 *
 *   npm run bundle && node verify/relay-proof.mjs <workflow>
 *
 * What runs is the real container entry point (dist/main.mjs, WORKFLOW=<id>)
 * on a loopback port: the same POST /invocations + GET /ping contract that
 * AgentCore calls, with provider clients bound to the session's twin base URLs
 * and the protected credential handoff loaded via `node --env-file` (never read
 * here). FetchSandbox drives POST /invocations and reads saved run state from
 * GET /verify/runs/{run}/cases/{case}/runs.
 *
 * Needs ~/.fetchsandbox/credentials.json (FetchSandbox device auth) and Node 22.
 * Writes verify/receipts/<workflow>.json and prints the receipt URL.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {requireFreePort,waitForOwnListener} from "./runtime-start.mjs";
import { coverage, scope } from "./contracts/lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const workflow = process.argv[2];
if (!workflow) {
  console.error("usage: node verify/relay-proof.mjs <support-escalation|revenue-reconciliation|churn-risk-sweep|onboarding-kickoff>");
  process.exit(2);
}
const contract = (await import(`./contracts/${workflow}.mjs`)).default;
const PORT = Number(process.env.PROOF_PORT ?? 8080);
// PROOF_BUNDLE lets several builders prove different workflows at once without sharing dist/main.mjs.
const BUNDLE = process.env.PROOF_BUNDLE ? join(ROOT, process.env.PROOF_BUNDLE) : join(ROOT, "dist", "main.mjs");
const gitSha = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim();
  } catch {
    return "local";
  }
})();
const APP_VERSION = `acme-ops-${workflow}-${JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version}-${gitSha}`;
const OUT_DIR = process.env.PROOF_OUT_DIR ?? join(tmpdir(), `acme-proof-${workflow}`);
mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
const save = (name, data) => writeFileSync(join(OUT_DIR, `${name}.json`), JSON.stringify(data, null, 2), {mode: 0o600});
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------------------
// FetchSandbox MCP over stdio
// ---------------------------------------------------------------------------
function mcpClient() {
  const apiKey = process.env.FETCHSANDBOX_API_KEY ?? JSON.parse(readFileSync(join(homedir(), ".fetchsandbox", "credentials.json"), "utf8")).apiKey;
  const cmd = process.env.FETCHSANDBOX_MCP_BIN ? ["node", [process.env.FETCHSANDBOX_MCP_BIN]] : ["npx", ["-y", "fetchsandbox-mcp@0.7.30"]];
  const child = spawn(cmd[0], cmd[1], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FETCHSANDBOX_BASE_URL: "https://fetchsandbox.com", FETCHSANDBOX_API_KEY: apiKey },
  });
  let buf = "";
  let next = 1;
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = msg.id != null && pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    }
  });
  child.stderr.on("data", () => {});
  const send = (method, params) => {
    const id = next++;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  return {
    child,
    async init() {
      const initialized = await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "acme-ops-proof", version: "1.0.0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return initialized.serverInfo;
    },
    async listTools(){return send("tools/list",{});},
    async call(name, args) {
      const result = await send("tools/call", { name, arguments: args });
      const text = (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      try {
        return text ? JSON.parse(text) : result;
      } catch {
        return { text, isError: result?.isError };
      }
    },
  };
}

async function settle(mcp, res, label) {
  let cur = res;
  for (let i = 0; i < 200; i++) {
    const nt = cur?.next_tool_call;
    const jobId = cur?.status === "running" && cur?.job_id ? cur.job_id : nt && (nt.name ?? nt.tool) === "get_job" ? (nt.arguments?.job_id ?? cur.job_id) : null;
    if (!jobId) return cur;
    if (i % 10 === 0) log(label, "waiting on job", jobId);
    await sleep(3000);
    cur = await mcp.call("get_job", { job_id: jobId });
  }
  return cur;
}

// ---------------------------------------------------------------------------
// The runtime under test
// ---------------------------------------------------------------------------
let app;
process.once("exit",()=>{app?.kill("SIGKILL");});
const stateFile = join(OUT_DIR, "state.json");

function twinEnv(legs) {
  const env = {};
  const map = {
    stripe: "STRIPE",
    hubspot: "HUBSPOT",
    gmail: "GMAIL",
    "google-calendar": "GOOGLE_CALENDAR",
    slack: "SLACK",
    zendesk: "ZENDESK",
    asana: "ASANA",
    workos: "WORKOS",
    github: "GITHUB",
    twilio: "TWILIO",
    pagerduty: "PAGERDUTY",
    notion: "NOTION",
    box: "BOX",
    square: "SQUARE",
  };
  for (const [p, leg] of Object.entries(legs ?? {})) {
    if (!map[p]) continue;
    env[`${map[p]}_BASE_URL`] = leg.base_url;
    env[`${map[p]}_API_KEY`] = leg.api_key;
  }
  return env;
}

async function startApp({ legs, credentialFile, flowRunId } = {}) {
  if (app) {
    const stopped=new Promise(resolve=>app.once("exit",resolve));
    app.kill("SIGKILL");
    await stopped;
  }
  // Inherit the host environment (proxy, CA bundle), but never any provider or
  // FetchSandbox credential: the runtime only gets the twins and the handoff file.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(STRIPE|HUBSPOT|GMAIL|GCAL|GOOGLE_CALENDAR|SLACK|ZENDESK|ASANA|WORKOS|GITHUB|TWILIO|PAGERDUTY|NOTION|BOX|TRADE_GOV|SCREENING|SQUARE|FETCHSANDBOX|ANTHROPIC|X_FLOW)_/.test(k)),
  );
  const env = {
    ...inherited,
    WORKFLOW: workflow,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    STATE_FILE: stateFile,
    PROVIDER_RETRIES: "2",
    // Optional runtime settings a contract needs (e.g. a shorter provider timeout), recorded in its source.
    ...(contract.appEnv ?? {}),
    ...twinEnv(legs),
    ...(flowRunId ? { X_FLOW_RUN_ID: flowRunId } : {}),
  };
  const args = [...(credentialFile ? [`--env-file=${credentialFile}`] : []), BUNDLE];
  await requireFreePort(PORT);
  app = spawn("node", args, { env, stdio: ["ignore", "pipe", "inherit"] });
  const listening=waitForOwnListener(app,PORT,workflow);
  app.stdout.on("data", (d) => process.env.PROOF_VERBOSE && process.stdout.write(d));
  await listening;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/ping`)).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("runtime did not answer /ping");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
if (!existsSync(BUNDLE)) throw new Error(`no bundle at ${BUNDLE}: run \`npm run bundle\` first`);
rmSync(stateFile, { force: true });
await startApp();

const mcp = mcpClient();
const mcpInfo = await mcp.init();
log("MCP observed", mcpInfo?.version ?? "unknown");
const tools=await mcp.listTools();save("mcp-tools",tools);for(const name of ["manage_tunnel","validate_integration","get_job"])if(!tools.tools?.some(t=>t.name===name))throw Error("Required MCP tool not discovered: "+name);
log("MCP tool discovery",tools.tools.map(t=>t.name).join(","));
let credentialFile;
const finish = async (code) => {
  try {
    await mcp.call("manage_tunnel", { action: "close" });
  } catch {}
  if (credentialFile) rmSync(dirname(credentialFile), { recursive: true, force: true });
  app?.kill("SIGKILL");
  mcp.child.kill();
  process.exit(code);
};

let tunnel;
for (let attempt = 0; attempt < 6; attempt++) {
  tunnel = await mcp.call("manage_tunnel", { action: "open", port: PORT });
  if (tunnel?.app_base_url) break;
  log("tunnel open retry", attempt, JSON.stringify(tunnel).slice(0, 200));
  await sleep(30_000);
}
save("tunnel", tunnel);
if (!tunnel?.app_base_url) {
  console.error("NO_TUNNEL", tunnel);
  await finish(2);
}
log("relay", tunnel.app_base_url);

const session = await mcp.call("validate_integration", { providers: contract.providers, app_base_url: tunnel.app_base_url });
save("session", session);
const sid = session.session_id;
if (!sid) {
  console.error("NO_SESSION", JSON.stringify(session).slice(0, 1000));
  await finish(3);
}
log("session", sid, Object.keys(session.legs ?? {}).join(","));
// Optional per-contract fixtures written straight to the session's twins (e.g. one
// Stripe customer per check, so checks never share provider state).
if (contract.seed) {
  const seeded = await contract.seed(session.legs, log, {mcp, sessionId:sid});
  save("seed", seeded);
  log("seeded", Object.keys(seeded ?? {}).length, "fixture(s)");
}
await startApp({ legs: session.legs });

const ctx = await settle(mcp, await mcp.call("validate_integration", { session_id: sid, application_context: { ...contract.context, app_version: APP_VERSION } }), "context");
save("context", ctx);
log("context", ctx.status ?? ctx.step, ctx.next_action ?? "");

const application_config = {
  app_version: APP_VERSION,
  disposable_test_app: true,
  require_verifier_token: true,
  coverage_review: coverage(contract.coverage, contract.checks),
  scope_review: contract.scope_review ?? scope(contract.checks, contract.evidence),
  checks: contract.checks,
  // Optional contract-specific config, e.g. event_destinations for signed webhooks.
  ...(contract.applicationConfig ?? {}),
};
save("application_config", application_config);
const cfg = await settle(mcp, await mcp.call("validate_integration", { session_id: sid, suite: "application_workflow_v1", application_config }), "configure");
save("configure", cfg);
const runId = cfg.run_id ?? cfg.attempt?.run_id ?? cfg.configuration?.run_id ?? cfg.next_tool_call?.arguments?.run_id;
if (!runId) {
  console.error("CONFIGURATION_FAILED", JSON.stringify(cfg.validation_errors ?? cfg.configuration_errors ?? cfg.text ?? cfg).slice(0, 4000));
  await finish(4);
}
log("run", runId);

const creds = await settle(mcp, await mcp.call("install_test_credentials", { session_id: sid, run_id: runId, ...(contract.envMapping ? { env_mapping: contract.envMapping } : {}) }), "credentials");
save("credentials", { variable_names: creds.variable_names, expires_in_seconds: creds.expires_in_seconds });
credentialFile = creds.credential_file;
if (!credentialFile) {
  console.error("NO_CREDENTIALS", JSON.stringify(creds).slice(0, 1000));
  await finish(5);
}
log("credential handoff installed:", (creds.variable_names ?? []).join(", "));
const appArgs = { legs: session.legs, credentialFile, flowRunId: cfg.request_headers?.["X-Flow-Run-Id"] ?? runId };
await startApp(appArgs);
const restarted = new Set();

let pre = await settle(mcp, await mcp.call("validate_integration", { session_id: sid, run_id: runId, preflight: true }), "preflight");
save("preflight", pre);
log("preflight", pre.status, pre.blocker ? JSON.stringify(pre.blocker).slice(0, 300) : "");
if (pre.status === "setup_blocked" && pre.resume_tool_call) {
  pre = await settle(mcp, await mcp.call("validate_integration", pre.resume_tool_call.arguments), "preflight-resume");
  save("preflight2", pre);
  log("preflight (resumed)", pre.status);
}
if (pre.status === "setup_blocked") {
  console.error("SETUP_BLOCKED", JSON.stringify(pre.blocker ?? pre).slice(0, 2000));
  await finish(6);
}

const exe = await settle(mcp, await mcp.call("validate_integration", { session_id: sid, run_id: runId, execute: true }), "execute");
save("execute", exe);
log("execute", exe.status ?? exe.step ?? "", exe.message_for_user ?? "");

let final = exe;
let settledPolls = 0;
const TERMINAL = ["passed", "failed", "failing", "completed", "error", "done", "inconclusive", "verified", "partially_verified"];
for (let i = 0; i < 120; i++) {
  await sleep(final.client_checkpoint ? 2_000 : Math.max(10_000, (final.retry_after_seconds ?? 10) * 1000));
  const st = await settle(mcp, await mcp.call("validate_integration", { session_id: sid }), `status-${i}`);
  final = st;
  save("status", st);
  // The verifier asked for a real restart: same state file, same bindings, new process.
  const checkpoint = st.client_checkpoint;
  if (checkpoint && !restarted.has(JSON.stringify(checkpoint))) {
    restarted.add(JSON.stringify(checkpoint));
    log("client_checkpoint → restarting runtime", JSON.stringify(checkpoint).slice(0, 200));
    await startApp(appArgs);
    continue;
  }
  const checks = st.checks ?? [];
  const tally = checks.reduce((t, c) => ((t[c.status] = (t[c.status] ?? 0) + 1), t), {});
  const verdict = typeof st.verdict === "string" ? st.verdict : (st.verdict?.overall ?? st.verdict?.state);
  log("poll", i, st.status ?? st.step ?? "", verdict ?? "", JSON.stringify(tally));
  if ((st.status ?? st.step) === "running") {
    settledPolls = 0;
    continue;
  }
  const done = st.complete === true || st.app_verified === true || TERMINAL.includes(String(st.status ?? st.step)) || TERMINAL.includes(String(verdict));
  settledPolls = done ? settledPolls + 1 : 0;
  if (settledPolls >= 2 || st.complete === true) break;
}
save("final", final);

const shareRaw = final.share_url ?? final.receipt_url ?? final.verdict?.share_url ?? final.attempt?.share_url ?? "";
const share = shareRaw ? (shareRaw.startsWith("http") ? shareRaw : `https://fetchsandbox.com${shareRaw.startsWith("/") ? "" : "/"}${shareRaw}`) : "";
const receipt = {
  workflow,
  mcp_observed: mcpInfo,
  mcp_source: process.env.FETCHSANDBOX_MCP_BIN ? "local_build" : "npm_package",
  app_version: APP_VERSION,
  session_id: sid,
  run_id: runId,
  receipt_url: share || null,
  status: final.status ?? final.step ?? null,
  verdict: typeof final.verdict === "string" ? final.verdict : (final.verdict ?? null),
  app_verified: final.app_verified ?? null,
  complete: final.complete ?? null,
  checks: (final.checks ?? []).map((c) => ({ id: c.id, status: c.status, explanation: c.explanation ?? c.reason ?? null })),
  recorded_at: new Date().toISOString(),
};
mkdirSync(join(HERE, "receipts"), { recursive: true });
writeFileSync(join(HERE, "receipts", `${workflow}.json`), JSON.stringify(receipt, null, 2) + "\n");
log("RECEIPT", share || "(none)");
for (const c of receipt.checks) log("check", c.id, c.status, String(c.explanation ?? "").slice(0, 160));
await finish(receipt.app_verified === true && receipt.checks.length === contract.checks.length && receipt.checks.every(c=>c.status==="held") ? 0 : 1);
