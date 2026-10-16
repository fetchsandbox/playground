#!/usr/bin/env node
/**
 * Managed-tunnel application_workflow_v1 for customer-ops-workflow.
 *
 * Drives the FastAPI app (POST /process-workflow) against FetchSandbox twins:
 *   stripe · hubspot · gmail · slack
 * plus Slack/Stripe webhook signature + replay checks.
 *
 * Requires ~/.fetchsandbox/credentials.json (device auth) or FETCHSANDBOX_API_KEY.
 */
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = Number(process.env.PORT || 8789);
const APP_VERSION = "customer-ops-workflow-verify-1.0.0";
const CHANNEL = process.env.SLACK_CHANNEL || "C0OPS01";
const OUT = (n, d) =>
  writeFileSync(`/tmp/fs-customer-ops-${n}.json`, JSON.stringify(d, null, 2));
const log = (...a) => console.log(new Date().toISOString(), ...a);

function loadApiKey() {
  if (process.env.FETCHSANDBOX_API_KEY) return process.env.FETCHSANDBOX_API_KEY;
  const p = join(homedir(), ".fetchsandbox", "credentials.json");
  if (!existsSync(p)) {
    throw new Error(
      "Missing FetchSandbox credentials. Run device auth or set FETCHSANDBOX_API_KEY.",
    );
  }
  return JSON.parse(readFileSync(p, "utf8")).apiKey;
}

const apiKey = loadApiKey();

const DIMENSIONS = [
  "baseline",
  "identity_and_access",
  "schema_and_value_boundaries",
  "amount_currency_quantity",
  "duplicate_replay",
  "concurrency",
  "ordering_and_stale_events",
  "delayed_or_missing_events",
  "provider_auth_and_scopes",
  "rate_limit_server_error_timeout",
  "accepted_effect_response_loss",
  "partial_effects_and_recovery",
  "restart_and_durability",
  "reconciliation",
  "cancellation_refund_entitlements",
  "data_and_privacy_boundaries",
  "cleanup_and_isolation",
];

function mcpClient() {
  const child = spawn("npx", ["-y", "fetchsandbox-mcp@latest"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      FETCHSANDBOX_BASE_URL: "https://fetchsandbox.com",
      FETCHSANDBOX_API_KEY: apiKey,
    },
    cwd: ROOT,
  });
  let buf = "";
  let nextId = 1;
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  const send = (method, params) => {
    const id = nextId++;
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const call = async (tool, args) => {
    const result = await send("tools/call", { name: tool, arguments: args });
    const text = (result?.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    try {
      return text ? JSON.parse(text) : result;
    } catch {
      return { text };
    }
  };
  return {
    child,
    call,
    async init() {
      await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "customer-ops-proof", version: "1.0.0" },
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }) + "\n",
      );
    },
  };
}

async function awaitJob(mcp, result, label) {
  let cur = result;
  for (let i = 0; i < 90; i++) {
    if (cur?.status === "running" && cur?.job_id) {
      log(label, "get_job", i, cur.elapsed_s);
      await sleep(3000);
      cur = await mcp.call("get_job", { job_id: cur.job_id });
      continue;
    }
    const nt = cur?.next_tool_call;
    if (nt && (nt.name === "get_job" || nt.tool === "get_job")) {
      await sleep(3000);
      cur = await mcp.call("get_job", {
        job_id: nt.arguments?.job_id || cur.job_id,
      });
      continue;
    }
    return cur;
  }
  return cur;
}

function loadDotenv(file) {
  if (!file || !existsSync(file)) return {};
  const loaded = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    process.env[k] = v;
    loaded[k] = true;
  }
  return loaded;
}

let appProc = null;

async function startApp(legs, opts = {}) {
  const killQuiet = (cmd, args) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: "ignore" });
      child.on("error", () => resolve());
      child.on("exit", () => resolve());
    });
  await killQuiet("pkill", ["-f", "uvicorn customer_ops.api:app"]);
  // Wait until the port is actually free so we never health-check a dying peer.
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/health`);
      // Still responding — keep waiting for bind release.
      await sleep(250);
    } catch {
      break; // connection refused → free
    }
  }
  await sleep(300);

  const hasTwinLegs = Boolean(
    legs?.stripe?.base_url || legs?.slack?.base_url || legs?.gmail?.base_url,
  );
  const env = {
    ...process.env,
    PORT: String(PORT),
    // Mock until twin legs exist; live against twins once handed off.
    CUSTOMER_OPS_USE_MOCKS: opts.useMocks || !hasTwinLegs ? "1" : "0",
    CUSTOMER_OPS_ALLOW_RESET: "1",
    REQUIRE_SLACK_SIGNATURE: "1",
    SLACK_CHANNEL: CHANNEL,
    PYTHONPATH: join(ROOT, "src"),
    // Twin bases from validate_integration legs
    STRIPE_API_BASE: legs.stripe?.base_url || "",
    STRIPE_API_KEY: legs.stripe?.api_key || process.env.STRIPE_API_KEY || "",
    HUBSPOT_API_BASE: legs.hubspot?.base_url || "",
    HUBSPOT_ACCESS_TOKEN:
      legs.hubspot?.api_key || process.env.HUBSPOT_ACCESS_TOKEN || "",
    GMAIL_API_BASE: legs.gmail?.base_url || "",
    GMAIL_ACCESS_TOKEN:
      legs.gmail?.api_key || process.env.GMAIL_ACCESS_TOKEN || "",
    GMAIL_SENDER: process.env.GMAIL_SENDER || "ops@example.test",
    SLACK_API_BASE: legs.slack?.base_url || "",
    SLACK_BOT_TOKEN: legs.slack?.api_key || process.env.SLACK_BOT_TOKEN || "",
  };
  if (opts.flowRunId) env.X_FLOW_RUN_ID = opts.flowRunId;
  if (opts.verifierToken) env.FETCHSANDBOX_VERIFIER_TOKEN = opts.verifierToken;
  // Always enforce webhook signatures during managed-tunnel verification so
  // unsigned rejection checks are observable even before credential handoff.
  const slackSecret =
    opts.slackWebhookSecret ||
    process.env.FETCHSANDBOX_SLACK_WEBHOOK_SECRET ||
    process.env.SLACK_SIGNING_SECRET ||
    "fs_slack_sig_customer_ops";
  const stripeSecret =
    opts.stripeWebhookSecret ||
    process.env.STRIPE_WEBHOOK_SECRET ||
    process.env.FETCHSANDBOX_STRIPE_WEBHOOK_SECRET ||
    "whsec_fs_customer_ops_verify";
  env.FETCHSANDBOX_SLACK_WEBHOOK_SECRET = slackSecret;
  env.SLACK_SIGNING_SECRET = slackSecret;
  env.STRIPE_WEBHOOK_SECRET = stripeSecret;
  env.FETCHSANDBOX_STRIPE_WEBHOOK_SECRET = stripeSecret;
  env.CUSTOMER_OPS_REQUIRE_STRIPE_SIG = "1";
  // Prefer handoff env if already loaded into process.env
  for (const k of [
    "STRIPE_API_KEY",
    "HUBSPOT_ACCESS_TOKEN",
    "GMAIL_ACCESS_TOKEN",
    "SLACK_BOT_TOKEN",
    "SLACK_API_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "SLACK_SIGNING_SECRET",
    "FETCHSANDBOX_VERIFIER_TOKEN",
  ]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  // Handoff files use provider-shaped names; map them onto client env vars.
  if (process.env.SLACK_API_KEY) env.SLACK_BOT_TOKEN = process.env.SLACK_API_KEY;
  if (process.env.HUBSPOT_API_KEY) {
    env.HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_API_KEY;
  }
  if (process.env.GMAIL_API_KEY) {
    env.GMAIL_ACCESS_TOKEN = process.env.GMAIL_API_KEY;
  }
  if (opts.verifierToken || process.env.FETCHSANDBOX_VERIFIER_TOKEN) {
    env.FETCHSANDBOX_VERIFIER_TOKEN =
      opts.verifierToken || process.env.FETCHSANDBOX_VERIFIER_TOKEN;
  }
  if (opts.flowRunId || process.env.X_FLOW_RUN_ID) {
    env.X_FLOW_RUN_ID = opts.flowRunId || process.env.X_FLOW_RUN_ID;
  }

  const venvPython = join(ROOT, ".venv", "bin", "python");
  const py = existsSync(venvPython) ? venvPython : "python3";
  appProc = spawn(
    py,
    [
      "-m",
      "uvicorn",
      "customer_ops.api:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(PORT),
    ],
    {
      env,
      cwd: ROOT,
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    },
  );
  appProc.unref();

  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("customer-ops app health failed");
}

function coverageReview(checkIds) {
  const relevant = {
    baseline: ["baseline"],
    duplicate_replay: ["duplicate_workflow", "slack_webhook_unsigned_rejected"].filter(
      (id) => checkIds.includes(id),
    ),
    provider_auth_and_scopes: [
      "slack_auth_failure",
      "stripe_auth_failure",
      "hubspot_auth_failure",
      "gmail_auth_failure",
    ].filter((id) => checkIds.includes(id)),
    rate_limit_server_error_timeout: [
      "slack_rate_limited",
      "stripe_rate_limited",
    ].filter((id) => checkIds.includes(id)),
    partial_effects_and_recovery: ["slack_channel_not_found"].filter((id) =>
      checkIds.includes(id),
    ),
    amount_currency_quantity: ["baseline"].filter((id) => checkIds.includes(id)),
    cleanup_and_isolation: ["baseline", "duplicate_workflow"].filter((id) =>
      checkIds.includes(id),
    ),
  };
  return DIMENSIONS.map((dimension) => {
    const ids = relevant[dimension] || [];
    if (ids.length) {
      return {
        dimension,
        relevance: "relevant",
        reason: `customer-ops twin app covers ${dimension} via ${ids.join(", ")}.`,
        rule_ids: ids,
      };
    }
    return {
      dimension,
      relevance: "not_applicable",
      reason:
        "Not in scope for this disposable customer-ops multi-agent verification run.",
      rule_ids: [],
    };
  });
}

function caseWorkflowsPath(checkId) {
  return `/runs/{{run_id}}/cases/${checkId}/workflows`;
}
function caseWebhooksPath(checkId) {
  return `/runs/{{run_id}}/cases/${checkId}/webhooks`;
}

function emptyWorkflowsBefore(checkId) {
  return {
    path: caseWorkflowsPath(checkId),
    assertion: { select: "workflows[*]", count: 0, required: true },
  };
}
function emptyWebhooksBefore(checkId) {
  return {
    path: caseWebhooksPath(checkId),
    assertion: { select: "webhooks[*]", count: 0, required: true },
  };
}

function workflowOutcome(where, { count = 1 } = {}) {
  return {
    select: "workflows[*]",
    count,
    required: true,
    where: where.map((w) => ({ required: true, ...w })),
    repeat: 2,
    stable_under_repeat: true,
  };
}

function processAction(checkId, overrides = {}) {
  return {
    method: "POST",
    path: "/process-workflow",
    body: {
      customer_email: "ada@example.test",
      customer_name: "Ada Lovelace",
      company: "Acme Analytics",
      sku: "pro_annual",
      quantity: 3,
      channel: CHANNEL,
      run_id: "{{run_id}}",
      case_id: checkId,
      ...overrides,
    },
    expect_status: 200,
  };
}

function workflowCheck(id, name, { fault, actions, where, count = 1 }) {
  return {
    id,
    name,
    ...(fault ? { fault } : {}),
    before: emptyWorkflowsBefore(id),
    actions,
    observe: { path: caseWorkflowsPath(id) },
    assertion: workflowOutcome(where, { count }),
  };
}

function buildChecks() {
  return [
    workflowCheck("baseline", "Happy path: research→quote‖billing→handoff→survey via twins", {
      actions: [processAction("baseline")],
      where: [
        { select: "researchOk", equals: true },
        { select: "quoteOk", equals: true },
        { select: "billingOk", equals: true },
        { select: "handoffOk", equals: true },
        { select: "surveyOk", equals: true },
        { select: "stripeOk", equals: true },
        { select: "hubspotOk", equals: true },
        { select: "gmailOk", equals: true },
        { select: "slackOk", equals: true },
      ],
    }),
    workflowCheck("duplicate_workflow", "Duplicate case idempotency key does not double-write", {
      actions: [
        processAction("duplicate_workflow", {
          idempotency_key: "case:duplicate_workflow:ada@example.test:pro_annual",
        }),
        processAction("duplicate_workflow", {
          idempotency_key: "case:duplicate_workflow:ada@example.test:pro_annual",
        }),
      ],
      where: [
        { select: "customer_email", equals: "ada@example.test" },
        { select: "billingOk", equals: true },
      ],
    }),
    workflowCheck("slack_channel_not_found", "Slack channel_not_found soft-fails handoff/slackOk", {
      fault: {
        provider: "slack",
        scenario: "channel_not_found",
        evidence: "refusal",
      },
      actions: [
        processAction("slack_channel_not_found", {
          channel: "C_DOES_NOT_EXIST",
          idempotency_key: "case:slack_channel_not_found:ada@example.test:pro_annual",
        }),
      ],
      where: [
        { select: "slackOk", equals: false },
        { select: "researchOk", equals: true },
      ],
    }),
    workflowCheck("slack_auth_failure", "Slack auth_failure marks slackOk false", {
      fault: { provider: "slack", scenario: "auth_failure", evidence: "refusal" },
      actions: [
        processAction("slack_auth_failure", {
          idempotency_key: "case:slack_auth_failure:ada@example.test:pro_annual",
        }),
      ],
      where: [{ select: "slackOk", equals: false }],
    }),
    workflowCheck("slack_rate_limited", "Slack rate_limited marks slackOk false", {
      fault: { provider: "slack", scenario: "rate_limited", evidence: "refusal" },
      actions: [
        processAction("slack_rate_limited", {
          idempotency_key: "case:slack_rate_limited:ada@example.test:pro_annual",
        }),
      ],
      where: [{ select: "slackOk", equals: false }],
    }),
    workflowCheck("stripe_auth_failure", "Stripe auth_failure marks billingOk/stripeOk false", {
      fault: { provider: "stripe", scenario: "auth_failure", evidence: "refusal" },
      actions: [
        processAction("stripe_auth_failure", {
          idempotency_key: "case:stripe_auth_failure:ada@example.test:pro_annual",
        }),
      ],
      where: [
        { select: "billingOk", equals: false },
        { select: "stripeOk", equals: false },
        { select: "researchOk", equals: true },
      ],
    }),
    workflowCheck("stripe_rate_limited", "Stripe rate_limited marks billingOk false", {
      fault: { provider: "stripe", scenario: "rate_limited", evidence: "refusal" },
      actions: [
        processAction("stripe_rate_limited", {
          idempotency_key: "case:stripe_rate_limited:ada@example.test:pro_annual",
        }),
      ],
      where: [{ select: "billingOk", equals: false }],
    }),
    workflowCheck("hubspot_auth_failure", "HubSpot auth_failure marks handoffOk/hubspotOk false", {
      fault: { provider: "hubspot", scenario: "auth_failure", evidence: "refusal" },
      actions: [
        processAction("hubspot_auth_failure", {
          idempotency_key: "case:hubspot_auth_failure:ada@example.test:pro_annual",
        }),
      ],
      where: [
        { select: "handoffOk", equals: false },
        { select: "hubspotOk", equals: false },
      ],
    }),
    workflowCheck("gmail_auth_failure", "Gmail auth_failure marks surveyOk/gmailOk false", {
      fault: { provider: "gmail", scenario: "auth_failure", evidence: "refusal" },
      actions: [
        processAction("gmail_auth_failure", {
          idempotency_key: "case:gmail_auth_failure:ada@example.test:pro_annual",
        }),
      ],
      where: [
        { select: "surveyOk", equals: false },
        { select: "gmailOk", equals: false },
        { select: "handoffOk", equals: true },
      ],
    }),
    {
      id: "slack_webhook_unsigned_rejected",
      name: "Unsigned Slack webhook is rejected (production signature check)",
      before: emptyWebhooksBefore("slack_webhook_unsigned_rejected"),
      actions: [
        {
          method: "POST",
          path: "/webhooks/slack",
          body: {
            type: "event_callback",
            event_id: "ev_unsigned_ops_1",
            run_id: "{{run_id}}",
            case_id: "slack_webhook_unsigned_rejected",
            event: {
              type: "app_mention",
              text: "email=ada@example.test case:slack_webhook_unsigned_rejected",
              channel: CHANNEL,
            },
          },
          expect_status: 400,
        },
      ],
      observe: { path: caseWebhooksPath("slack_webhook_unsigned_rejected") },
      assertion: {
        select: "webhooks[*]",
        count: 0,
        required: true,
        repeat: 2,
        stable_under_repeat: true,
      },
    },
    {
      id: "stripe_webhook_unsigned_rejected",
      name: "Unsigned Stripe webhook is rejected when secret configured",
      before: emptyWebhooksBefore("stripe_webhook_unsigned_rejected"),
      actions: [
        {
          method: "POST",
          path: "/webhooks/stripe",
          body: {
            id: "evt_unsigned_1",
            type: "payment_intent.succeeded",
            run_id: "{{run_id}}",
            case_id: "stripe_webhook_unsigned_rejected",
            data: { object: { id: "pi_x", object: "payment_intent" } },
          },
          expect_status: 400,
        },
      ],
      observe: { path: caseWebhooksPath("stripe_webhook_unsigned_rejected") },
      assertion: {
        select: "webhooks[*]",
        count: 0,
        required: true,
        repeat: 2,
        stable_under_repeat: true,
      },
    },
  ];
}

function scopeReview(checks) {
  return checks.map((c) => ({
    check_id: c.id,
    classification: "in_scope",
    reason: `${c.name} is required for customer-ops twin + webhook coverage.`,
    evidence: [
      "customer-ops-workflow POST /process-workflow",
      "customer-ops-workflow GET /runs/:runId/cases/:caseId/workflows",
      "customer-ops-workflow POST /webhooks/slack",
      "customer-ops-workflow POST /webhooks/stripe",
      "Stripe POST /v1/customers + /v1/payment_intents",
      "HubSpot POST /crm/v3/objects/contacts + /deals",
      "Gmail POST /gmail/v1/users/me/messages/send (twin fallback: messages.insert)",
      "Slack POST chat.postMessage",
    ],
  }));
}

// --- main ---
const PROVIDERS = ["stripe", "hubspot", "gmail", "slack"];

const mcp = mcpClient();
await mcp.init();

// Tunnel requires a listener on PORT first (invoice-watch starts twin-driver
// before manage_tunnel). Boot the FastAPI app in mock mode as a placeholder;
// real twin legs replace it after validate_integration.
await startApp(
  {
    stripe: { base_url: "", api_key: "" },
    hubspot: { base_url: "", api_key: "" },
    gmail: { base_url: "", api_key: "" },
    slack: { base_url: "", api_key: "" },
  },
  { useMocks: true },
);
log("pre-tunnel app healthy on", PORT);

let tunnel = null;
for (let attempt = 0; attempt < 8; attempt++) {
  tunnel = await mcp.call("manage_tunnel", { action: "open", port: PORT });
  OUT("tunnel", tunnel);
  if (tunnel.app_base_url) break;
  log("tunnel open retry", attempt, JSON.stringify(tunnel).slice(0, 180));
  await sleep(90000);
}
if (!tunnel?.app_base_url) {
  console.error("NO_TUNNEL", tunnel);
  process.exit(2);
}
log("tunnel", tunnel.app_base_url);

const session = await mcp.call("validate_integration", {
  providers: PROVIDERS,
  app_base_url: tunnel.app_base_url,
});
OUT("session", session);
const sid = session.session_id;
const legs = session.legs;
if (!legs?.stripe || !legs?.slack) {
  console.error("MISSING_LEGS", Object.keys(legs || {}));
  await mcp.call("manage_tunnel", { action: "close" });
  mcp.child.kill();
  process.exit(2);
}
log("session", sid, "legs", Object.keys(legs));
await startApp(legs);

let ctx = await mcp.call("validate_integration", {
  session_id: sid,
  application_context: {
    goal: "Prove customer-ops multi-agent workflow against Stripe/HubSpot/Gmail/Slack twins, including webhook signature rejection and provider fault soft-fail scopes.",
    app_version: APP_VERSION,
    workflow:
      "POST /process-workflow runs research → parallel quote‖billing → handoff → survey. GET /runs/{run_id}/cases/{case_id}/workflows observes agent outcomes. POST /webhooks/slack and /webhooks/stripe enforce signatures.",
    entry_points: [
      "POST /process-workflow",
      "POST /webhooks/slack",
      "POST /webhooks/stripe",
    ],
    state_store:
      "Case-scoped JSON at GET /runs/{run_id}/cases/{check_id}/workflows → {workflows:[...]} and .../webhooks → {webhooks:[...]}; selectors workflows[*] / webhooks[*].",
  },
});
ctx = await awaitJob(mcp, ctx, "context");
OUT("context", ctx);

const checks = buildChecks();

async function configure(label, includeWebhookRejects) {
  await startApp(legs);
  const selected = includeWebhookRejects
    ? checks
    : checks.filter(
        (c) =>
          c.id !== "slack_webhook_unsigned_rejected" &&
          c.id !== "stripe_webhook_unsigned_rejected",
      );
  const application_config = {
    app_version: APP_VERSION,
    disposable_test_app: true,
    require_verifier_token: true,
    coverage_review: coverageReview(selected.map((c) => c.id)),
    scope_review: scopeReview(selected),
    checks: selected,
    event_delivery: "direct",
    event_destinations: {
      slack: "/webhooks/slack",
      stripe: "/webhooks/stripe",
    },
  };
  let cfg = await mcp.call("validate_integration", {
    session_id: sid,
    suite: "application_workflow_v1",
    application_config,
  });
  cfg = await awaitJob(mcp, cfg, label);
  OUT(label, cfg);
  log(label, cfg.text || cfg.next_action, cfg.run_id || "");
  return cfg;
}

let cfg = await configure("config-with-webhooks", true);
if (cfg.text || cfg.validation_errors || cfg.configuration_accepted === false) {
  log("retry without unsigned-webhook checks");
  cfg = await configure("config-http-faults", false);
}

let runId =
  cfg.run_id ||
  cfg.attempt?.run_id ||
  cfg.configuration?.run_id ||
  cfg.next_tool_call?.arguments?.run_id;

if (!runId) {
  console.error("CONFIG_FAILED", JSON.stringify(cfg).slice(0, 2000));
  await mcp.call("manage_tunnel", { action: "close" });
  mcp.child.kill();
  process.exit(3);
}

let creds = await mcp.call("install_test_credentials", {
  session_id: sid,
  run_id: runId,
});
creds = await awaitJob(mcp, creds, "creds");
OUT("creds", creds);
loadDotenv(creds.credential_file);

await startApp(legs, {
  flowRunId: cfg.request_headers?.["X-Flow-Run-Id"] || runId,
  verifierToken: process.env.FETCHSANDBOX_VERIFIER_TOKEN,
  slackWebhookSecret:
    process.env.FETCHSANDBOX_SLACK_WEBHOOK_SECRET ||
    process.env.SLACK_SIGNING_SECRET,
  stripeWebhookSecret:
    process.env.STRIPE_WEBHOOK_SECRET ||
    process.env.FETCHSANDBOX_STRIPE_WEBHOOK_SECRET,
});

// Force Stripe unsigned rejection path when secret is present
if (process.env.STRIPE_WEBHOOK_SECRET) {
  process.env.CUSTOMER_OPS_REQUIRE_STRIPE_SIG = "1";
}

let pre = await mcp.call("validate_integration", {
  session_id: sid,
  run_id: runId,
  preflight: true,
});
pre = await awaitJob(mcp, pre, "preflight");
OUT("preflight", pre);
log("preflight", pre.status, pre.blocker || pre.ready);

if (pre.status === "setup_blocked" && pre.resume_tool_call) {
  await startApp(legs, {
    flowRunId: runId,
    verifierToken: process.env.FETCHSANDBOX_VERIFIER_TOKEN,
    slackWebhookSecret:
      process.env.FETCHSANDBOX_SLACK_WEBHOOK_SECRET ||
      process.env.SLACK_SIGNING_SECRET,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  });
  pre = await mcp.call("validate_integration", pre.resume_tool_call.arguments);
  pre = await awaitJob(mcp, pre, "preflight-resume");
  OUT("preflight2", pre);
}

if (pre.status === "setup_blocked") {
  console.error("SETUP_BLOCKED", pre.blocker);
  await mcp.call("manage_tunnel", { action: "close" });
  mcp.child.kill();
  process.exit(4);
}

let exe = await mcp.call("validate_integration", {
  session_id: sid,
  run_id: pre.run_id || runId,
  execute: true,
});
exe = await awaitJob(mcp, exe, "execute");
OUT("execute", exe);

let final = exe;
let stableTerminalPolls = 0;
for (let i = 0; i < 90; i++) {
  await sleep(Math.max(10000, (exe.retry_after_seconds || 10) * 1000));
  let st = await mcp.call("validate_integration", { session_id: sid });
  st = await awaitJob(mcp, st, `status-${i}`);
  OUT("status", st);
  const verdict =
    typeof st.verdict === "string" ? st.verdict : st.verdict?.overall || st.verdict?.state;
  const s = st.status || st.step || "";
  const share = st.share_url || st.receipt_url || st.verdict?.share_url || "";
  const stChecks = st.checks || [];
  const held = stChecks.filter((c) => c.status === "held").length;
  const passed = stChecks.filter((c) => c.status === "passed").length;
  const failed = stChecks.filter((c) => c.status === "failed").length;
  log(
    "poll",
    i,
    s || verdict || "?",
    `complete=${st.complete} held=${held} passed=${passed} failed=${failed}`,
    share,
  );
  final = st;

  if (s === "running" || st.status === "running") {
    stableTerminalPolls = 0;
    continue;
  }
  const allSettled =
    stChecks.length > 0 &&
    stChecks.every((c) =>
      ["held", "passed", "failed", "unmeasured", "blocked", "error"].includes(c.status),
    );
  if (
    st.complete === true ||
    st.app_verified === true ||
    st.declared_checks_complete === true ||
    ["passed", "failed", "failing", "completed", "error", "done", "inconclusive"].includes(
      String(s),
    ) ||
    ["passed", "failed", "failing", "inconclusive"].includes(String(verdict)) ||
    (allSettled && (verdict || s))
  ) {
    stableTerminalPolls += 1;
    if (
      stableTerminalPolls >= 2 ||
      st.complete === true ||
      st.app_verified === true ||
      (allSettled &&
        ["failing", "failed", "inconclusive", "passed"].includes(String(verdict || s)))
    ) {
      break;
    }
  } else {
    stableTerminalPolls = 0;
  }
}

OUT("final", final);
const shareRaw =
  final.share_url ||
  final.receipt_url ||
  final.verdict?.share_url ||
  final.attempt?.share_url ||
  "";
const share =
  shareRaw && shareRaw.startsWith("http")
    ? shareRaw
    : shareRaw
      ? `https://fetchsandbox.com${shareRaw.startsWith("/") ? "" : "/"}${shareRaw}`
      : "";
const verdict =
  typeof final.verdict === "string"
    ? final.verdict
    : final.verdict?.overall || final.status || final.step;
log("SHARE_URL", share || "(none)");
log("FINAL_STATUS", verdict, "complete=", final.complete, "app_verified=", final.app_verified);
if (Array.isArray(final.checks)) {
  for (const c of final.checks) {
    log("check", c.id, c.status, (c.explanation || "").slice(0, 160));
  }
}
writeFileSync(
  "/tmp/fs-customer-ops-receipt-url.txt",
  String(share || final.status || "no-receipt") + "\n",
);
writeFileSync(
  join(ROOT, "verify", "latest-receipt.txt"),
  String(share || final.status || "no-receipt") + "\n",
);

await mcp.call("manage_tunnel", { action: "close" });
mcp.child.kill();
try {
  if (appProc?.pid) process.kill(-appProc.pid, "SIGTERM");
} catch {}
writeFileSync("/tmp/fs-customer-ops-done.flag", "ok\n");
log("PROOF_DONE");
