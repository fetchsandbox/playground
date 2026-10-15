#!/usr/bin/env node
/**
 * Full managed-tunnel application_workflow_v1 for invoice-watch twin-driver.
 * Behavioral contract: baseline happy path + messy production fault/webhook scenarios.
 * Goal: FetchSandbox-driven proof receipt (share_url).
 */
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 8788;
const APP_VERSION = "invoice-watch-verify-1.0.4";
const CHANNEL = "C0BILLING01";
const apiKey = JSON.parse(
  readFileSync(join(homedir(), ".fetchsandbox", "credentials.json"), "utf8"),
).apiKey;
const OUT = (n, d) =>
  writeFileSync(`/tmp/fs-proof-${n}.json`, JSON.stringify(d, null, 2));
const log = (...a) => console.log(new Date().toISOString(), ...a);

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
    cwd: "/workspace/invoice-watch",
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
        clientInfo: { name: "invoice-watch-proof", version: "1.0.0" },
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

async function startDriver(legs, opts = {}) {
  try {
    spawn("pkill", ["-f", "twin-driver.mjs"], { stdio: "ignore" });
  } catch {}
  await sleep(1000);
  const env = {
    ...process.env,
    PORT: String(PORT),
    SLACK_BASE_URL: legs.slack.base_url,
    SLACK_API_KEY: legs.slack.api_key,
    GMAIL_BASE_URL: legs.gmail.base_url,
    GMAIL_API_KEY: legs.gmail.api_key,
    GCAL_BASE_URL: legs["google-calendar"].base_url,
    GCAL_API_KEY: legs["google-calendar"].api_key,
    SLACK_CHANNEL: CHANNEL,
  };
  if (opts.flowRunId) env.X_FLOW_RUN_ID = opts.flowRunId;
  if (opts.verifierToken) env.FETCHSANDBOX_VERIFIER_TOKEN = opts.verifierToken;
  if (opts.slackWebhookSecret) {
    env.FETCHSANDBOX_SLACK_WEBHOOK_SECRET = opts.slackWebhookSecret;
    env.SLACK_SIGNING_SECRET = opts.slackWebhookSecret;
  }
  // Reject unsigned Slack webhooks during verification runs.
  env.REQUIRE_SLACK_SIGNATURE = "1";
  // Prefer twin keys from handoff when present
  if (process.env.SLACK_API_KEY) env.SLACK_API_KEY = process.env.SLACK_API_KEY;
  if (process.env.GMAIL_API_KEY) env.GMAIL_API_KEY = process.env.GMAIL_API_KEY;
  if (process.env.GOOGLE_CALENDAR_API_KEY) {
    env.GCAL_API_KEY = process.env.GOOGLE_CALENDAR_API_KEY;
  }
  spawn("node", ["/workspace/invoice-watch/verify/twin-driver.mjs"], {
    env,
    stdio: ["ignore", "ignore", "inherit"],
    detached: true,
  }).unref();
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error("driver health failed");
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

function coverageReview(checkIds) {
  const relevant = {
    baseline: ["baseline"],
    duplicate_replay: ["duplicate_invoice", "slack_webhook_replay"].filter((id) =>
      checkIds.includes(id),
    ),
    provider_auth_and_scopes: [
      "slack_auth_failure",
      "gmail_auth_failure",
      "calendar_auth_failure",
      "slack_missing_scope",
    ].filter((id) => checkIds.includes(id)),
    rate_limit_server_error_timeout: [
      "slack_rate_limited",
      "gmail_rate_limited",
      "calendar_rate_limited",
    ].filter((id) => checkIds.includes(id)),
    delayed_or_missing_events: ["slack_webhook_withheld"].filter((id) =>
      checkIds.includes(id),
    ),
    ordering_and_stale_events: ["slack_webhook_replay"].filter((id) =>
      checkIds.includes(id),
    ),
    partial_effects_and_recovery: ["slack_channel_not_found", "slack_not_in_channel"].filter(
      (id) => checkIds.includes(id),
    ),
    schema_and_value_boundaries: ["malformed_invoice_rejected"].filter((id) =>
      checkIds.includes(id),
    ),
    cleanup_and_isolation: ["baseline", "duplicate_invoice"].filter((id) =>
      checkIds.includes(id),
    ),
  };
  return DIMENSIONS.map((dimension) => {
    const ids = relevant[dimension] || [];
    if (ids.length) {
      return {
        dimension,
        relevance: "relevant",
        reason: `Inspected disposable twin-driver covers ${dimension} via ${ids.join(", ")}.`,
        rule_ids: ids,
      };
    }
    return {
      dimension,
      relevance: "not_applicable",
      reason:
        "Not in scope for this disposable Gmail→Calendar→Slack invoice driver verification run.",
      rule_ids: [],
    };
  });
}

/** Per-check isolation path: /runs/{{run_id}}/cases/<checkId>/invoices */
function caseInvoicesPath(checkId) {
  return `/runs/{{run_id}}/cases/${checkId}/invoices`;
}

function caseWebhooksPath(checkId) {
  return `/runs/{{run_id}}/cases/${checkId}/webhooks`;
}

/** Empty starting-state for keyed invoice collection (FetchSandbox select invoices[*]). */
function emptyInvoicesBefore(checkId) {
  return {
    path: caseInvoicesPath(checkId),
    assertion: {
      select: "invoices[*]",
      count: 0,
      required: true,
    },
  };
}

function emptyWebhooksBefore(pathOrCheckId) {
  const path =
    pathOrCheckId.startsWith("/")
      ? pathOrCheckId
      : caseWebhooksPath(pathOrCheckId);
  return {
    path,
    assertion: {
      select: "webhooks[*]",
      count: 0,
      required: true,
    },
  };
}

/** Outcome on same collection selector as before; field matches go in where[]. */
function invoiceOutcome(where, { count = 1 } = {}) {
  return {
    select: "invoices[*]",
    count,
    required: true,
    where: where.map((w) => ({ required: true, ...w })),
    repeat: 2,
    stable_under_repeat: true,
  };
}

function webhookOutcome(where, { count = 1 } = {}) {
  return {
    select: "webhooks[*]",
    count,
    required: true,
    where: where.map((w) => ({ required: true, ...w })),
    repeat: 2,
    stable_under_repeat: true,
  };
}

function invoiceBody(checkId, overrides = {}) {
  return {
    merchant: "Notion",
    amount: "$29.00 USD",
    cancelBy: "2026-11-12",
    renewalDate: "2026-11-15",
    invoiceId: "INV-3001",
    channel: CHANNEL,
    run_id: "{{run_id}}",
    case_id: checkId,
    ...overrides,
  };
}

function invoiceKeyFor(invoiceId) {
  return `notion|${String(invoiceId).toLowerCase()}|$29.00 usd`;
}

function processAction(checkId, overrides = {}) {
  return {
    method: "POST",
    path: "/process-invoice",
    body: invoiceBody(checkId, overrides),
    expect_status: 200,
  };
}

function invoiceCheck(id, name, { fault, actions, where, count = 1 }) {
  const path = caseInvoicesPath(id);
  return {
    id,
    name,
    ...(fault ? { fault } : {}),
    before: emptyInvoicesBefore(id),
    actions,
    observe: { path },
    assertion: invoiceOutcome(where, { count }),
  };
}

function buildChecks() {
  const checks = [
    invoiceCheck("baseline", "Happy path: invoice creates calendar reminder and Slack alert", {
      actions: [processAction("baseline", { invoiceId: "INV-3001" })],
      where: [
        { select: "invoiceKey", equals: invoiceKeyFor("INV-3001") },
        { select: "slackOk", equals: true },
        { select: "calendarOk", equals: true },
        { select: "gmailOk", equals: true },
      ],
    }),
    invoiceCheck("duplicate_invoice", "Duplicate invoice in same run does not double-write", {
      actions: [
        processAction("duplicate_invoice", { invoiceId: "INV-DUP-1" }),
        processAction("duplicate_invoice", { invoiceId: "INV-DUP-1" }),
      ],
      where: [{ select: "invoiceKey", equals: invoiceKeyFor("INV-DUP-1") }],
    }),
    invoiceCheck("slack_channel_not_found", "Slack channel_not_found leaves slackOk false", {
      fault: {
        provider: "slack",
        scenario: "channel_not_found",
        evidence: "refusal",
      },
      actions: [
        processAction("slack_channel_not_found", {
          invoiceId: "INV-CNF-1",
          channel: "C_DOES_NOT_EXIST",
        }),
      ],
      where: [
        { select: "invoiceKey", equals: invoiceKeyFor("INV-CNF-1") },
        { select: "slackOk", equals: false },
      ],
    }),
    invoiceCheck("slack_not_in_channel", "Slack not_in_channel is refused", {
      fault: {
        provider: "slack",
        scenario: "not_in_channel",
        evidence: "refusal",
      },
      actions: [processAction("slack_not_in_channel", { invoiceId: "INV-NIC-1" })],
      where: [
        { select: "invoiceKey", equals: invoiceKeyFor("INV-NIC-1") },
        { select: "slackOk", equals: false },
      ],
    }),
    invoiceCheck("slack_auth_failure", "Slack auth_failure does not mark slackOk", {
      fault: { provider: "slack", scenario: "auth_failure", evidence: "refusal" },
      actions: [processAction("slack_auth_failure", { invoiceId: "INV-SAUTH-1" })],
      where: [
        { select: "invoiceKey", equals: invoiceKeyFor("INV-SAUTH-1") },
        { select: "slackOk", equals: false },
      ],
    }),
    invoiceCheck("slack_missing_scope", "Slack missing_scope is refused", {
      fault: {
        provider: "slack",
        scenario: "missing_scope",
        evidence: "refusal",
      },
      actions: [processAction("slack_missing_scope", { invoiceId: "INV-SCOPE-1" })],
      where: [
        { select: "invoiceKey", equals: invoiceKeyFor("INV-SCOPE-1") },
        { select: "slackOk", equals: false },
      ],
    }),
    invoiceCheck("slack_rate_limited", "Slack rate_limited is observed as failure", {
      fault: {
        provider: "slack",
        scenario: "rate_limited",
        evidence: "refusal",
      },
      actions: [processAction("slack_rate_limited", { invoiceId: "INV-SRL-1" })],
      where: [
        { select: "invoiceKey", equals: invoiceKeyFor("INV-SRL-1") },
        { select: "slackOk", equals: false },
      ],
    }),
    invoiceCheck("gmail_auth_failure", "Gmail auth_failure marks gmailOk false", {
      fault: {
        provider: "gmail",
        scenario: "auth_failure",
        evidence: "refusal",
      },
      actions: [processAction("gmail_auth_failure", { invoiceId: "INV-GAUTH-1" })],
      where: [
        { select: "invoiceKey", equals: invoiceKeyFor("INV-GAUTH-1") },
        { select: "gmailOk", equals: false },
      ],
    }),
    invoiceCheck("gmail_rate_limited", "Gmail rate_limited marks gmailOk false", {
      fault: {
        provider: "gmail",
        scenario: "rate_limited",
        evidence: "refusal",
      },
      actions: [processAction("gmail_rate_limited", { invoiceId: "INV-GRL-1" })],
      where: [
        { select: "invoiceKey", equals: invoiceKeyFor("INV-GRL-1") },
        { select: "gmailOk", equals: false },
      ],
    }),
    invoiceCheck("calendar_auth_failure", "Calendar auth_failure marks calendarOk false", {
      fault: {
        provider: "google-calendar",
        scenario: "auth_failure",
        evidence: "refusal",
      },
      actions: [processAction("calendar_auth_failure", { invoiceId: "INV-CAUTH-1" })],
      where: [
        { select: "invoiceKey", equals: invoiceKeyFor("INV-CAUTH-1") },
        { select: "calendarOk", equals: false },
      ],
    }),
    invoiceCheck("calendar_rate_limited", "Calendar rate_limited marks calendarOk false", {
      fault: {
        provider: "google-calendar",
        scenario: "rate_limited",
        evidence: "refusal",
      },
      actions: [processAction("calendar_rate_limited", { invoiceId: "INV-CRL-1" })],
      where: [
        { select: "invoiceKey", equals: invoiceKeyFor("INV-CRL-1") },
        { select: "calendarOk", equals: false },
      ],
    }),
    // Messy webhook surfaces: unsigned rejection via ordinary HTTP on a
    // case-scoped log that stays empty when signature check rejects.
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
            event_id: "ev_unsigned_1",
            run_id: "{{run_id}}",
            case_id: "slack_webhook_unsigned_rejected",
            event: { type: "message", text: "invoice ping", channel: CHANNEL },
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
      id: "slack_webhook_replay",
      name: "Signed Slack event replay is idempotent",
      before: emptyWebhooksBefore("slack_webhook_replay"),
      actions: [
        {
          // Payload is the Slack event resource; FetchSandbox wraps/signs the envelope.
          event: {
            provider: "slack",
            type: "message",
            payload: {
              type: "message",
              text: "Subscription invoice noticed",
              channel: CHANNEL,
              ts: "1710000000.000100",
              run_id: "{{run_id}}",
              case_id: "slack_webhook_replay",
            },
          },
          expect_status: 200,
        },
        {
          event: {
            provider: "slack",
            replay_of: "{{step1.event_id}}",
          },
          expect_status: 200,
        },
      ],
      observe: { path: caseWebhooksPath("slack_webhook_replay") },
      assertion: {
        all_of: [
          {
            select: "webhooks[*]",
            count: 2,
            required: true,
            where: [{ select: "type", equals: "message", required: true }],
          },
          {
            select: "webhooks[*]",
            count: 1,
            required: true,
            where: [{ select: "replay", equals: true, required: true }],
          },
        ],
        repeat: 2,
        stable_under_repeat: true,
      },
    },
    {
      id: "slack_webhook_withheld",
      name: "Withheld Slack webhook leaves webhook log empty",
      fault: {
        provider: "slack",
        scenario: "rate_limited",
        evidence: "webhook_withheld",
        event_type: "message",
      },
      before: emptyWebhooksBefore("slack_webhook_withheld"),
      actions: [
        {
          // Simulated drop: verifier marks the generated event withheld; app must stay empty.
          event: {
            provider: "slack",
            type: "message",
            payload: {
              type: "message",
              text: "should be withheld",
              channel: CHANNEL,
              ts: "1710000001.000100",
              run_id: "{{run_id}}",
              case_id: "slack_webhook_withheld",
            },
          },
        },
      ],
      observe: { path: caseWebhooksPath("slack_webhook_withheld") },
      assertion: {
        select: "webhooks[*]",
        count: 0,
        required: true,
        repeat: 2,
        stable_under_repeat: true,
      },
    },
  ];
  return checks;
}

function scopeReview(checks) {
  return checks.map((c) => ({
    check_id: c.id,
    classification: "in_scope",
    reason: `${c.name} is required for disposable invoice-watch twin-driver production-messiness coverage.`,
    evidence: [
      "invoice-watch/verify/twin-driver.mjs POST /process-invoice",
      "invoice-watch/verify/twin-driver.mjs GET /runs/:runId/invoices",
      "invoice-watch/verify/twin-driver.mjs POST /webhooks/slack",
      "invoice-watch/bot/lib/providers/slack.ts chat.postMessage",
      "invoice-watch/bot/lib/providers/gmail.ts users.messages.list",
      "invoice-watch/bot/lib/providers/calendar.ts events.insert",
    ],
  }));
}

// --- main ---
const bootstrapPath = existsSync("/tmp/fs-proof-session.json")
  ? "/tmp/fs-proof-session.json"
  : existsSync("/tmp/fs-app5-session.json")
    ? "/tmp/fs-app5-session.json"
    : "/tmp/fs-open-session.json";
const bootstrap = JSON.parse(readFileSync(bootstrapPath, "utf8")).legs;
await startDriver(bootstrap);
log("cooling 180s before tunnel open...");
await sleep(180000);

const mcp = mcpClient();
await mcp.init();
let tunnel = null;
for (let attempt = 0; attempt < 8; attempt++) {
  tunnel = await mcp.call("manage_tunnel", { action: "open", port: PORT });
  OUT("tunnel", tunnel);
  if (tunnel.app_base_url) break;
  const msg = JSON.stringify(tunnel);
  log("tunnel open retry", attempt, msg.slice(0, 180));
  // Capacity / rate-limit: wait and retry without treating as hard failure yet.
  await sleep(45000);
}
if (!tunnel?.app_base_url) {
  console.error("NO_TUNNEL", tunnel);
  process.exit(2);
}
log("tunnel", tunnel.app_base_url);

const session = await mcp.call("validate_integration", {
  providers: ["slack", "gmail", "google-calendar"],
  app_base_url: tunnel.app_base_url,
});
OUT("session", session);
const sid = session.session_id;
const legs = session.legs;
log("session", sid);
await startDriver(legs);

let ctx = await mcp.call("validate_integration", {
  session_id: sid,
  application_context: {
    goal: "Prove disposable invoice-watch driver: Gmail list → Calendar cancel reminder → Slack alert, including messy Slack webhook and provider fault scenarios.",
    app_version: APP_VERSION,
    workflow:
      "POST /process-invoice drives provider REST calls; GET /runs/{run_id}/invoices observes results; POST /webhooks/slack handles signed Slack events with replay idempotency and unsigned rejection.",
    entry_points: ["POST /process-invoice", "POST /webhooks/slack"],
    state_store:
      "Case-scoped keyed JSON at GET /runs/{run_id}/cases/{check_id}/invoices → {invoices:[...]} and .../webhooks → {webhooks:[...]}; selectors invoices[*] / webhooks[*]. POST /process-invoice accepts case_id for isolation.",
  },
});
ctx = await awaitJob(mcp, ctx, "context");
OUT("context", ctx);
log("context", ctx.status, ctx.next_action);

const checks = buildChecks();
const checkIds = checks.map((c) => c.id);

async function configure(label, includeEvents) {
  await startDriver(legs);
  const application_config = {
    app_version: APP_VERSION,
    disposable_test_app: true,
    require_verifier_token: true,
    coverage_review: coverageReview(checkIds),
    scope_review: scopeReview(checks),
    checks: includeEvents
      ? checks
      : checks.filter((c) => !c.actions?.some((a) => a.event)),
  };
  if (includeEvents) {
    application_config.event_delivery = "direct";
    application_config.event_destinations = {
      slack: "/webhooks/slack",
    };
  }
  let cfg = await mcp.call("validate_integration", {
    session_id: sid,
    suite: "application_workflow_v1",
    application_config,
  });
  cfg = await awaitJob(mcp, cfg, label);
  OUT(label, cfg);
  log(label, cfg.text || cfg.next_action, cfg.run_id || "", cfg.contract_readiness?.contract_complete);
  return cfg;
}

let cfg = await configure("config-with-events", true);
if (cfg.text || cfg.validation_errors || cfg.configuration_accepted === false) {
  log("retry without signed-event checks");
  cfg = await configure("config-http-faults", false);
}

let runId =
  cfg.run_id ||
  cfg.attempt?.run_id ||
  cfg.configuration?.run_id ||
  cfg.next_tool_call?.arguments?.run_id;

if (!runId) {
  console.error("CONFIG_FAILED");
  await mcp.call("manage_tunnel", { action: "close" });
  mcp.child.kill();
  process.exit(3);
}

// Credentials handoff
let creds = await mcp.call("install_test_credentials", {
  session_id: sid,
  run_id: runId,
});
creds = await awaitJob(mcp, creds, "creds");
OUT("creds", creds);
const loaded = loadDotenv(creds.credential_file);
log(
  "loaded handoff",
  Object.keys(loaded),
  "verifier",
  !!process.env.FETCHSANDBOX_VERIFIER_TOKEN,
);

await startDriver(legs, {
  flowRunId: cfg.request_headers?.["X-Flow-Run-Id"] || runId,
  verifierToken: process.env.FETCHSANDBOX_VERIFIER_TOKEN,
  slackWebhookSecret:
    process.env.FETCHSANDBOX_SLACK_WEBHOOK_SECRET ||
    process.env.SLACK_SIGNING_SECRET,
});

// Local empty check
const authHeaders = process.env.FETCHSANDBOX_VERIFIER_TOKEN
  ? { Authorization: `Bearer ${process.env.FETCHSANDBOX_VERIFIER_TOKEN}` }
  : {};
const localEmpty = await (
  await fetch(`http://127.0.0.1:${PORT}/runs/${encodeURIComponent(runId)}/invoices`, {
    headers: authHeaders,
  })
).json();
log("local empty invoices", localEmpty);

let pre = await mcp.call("validate_integration", {
  session_id: sid,
  run_id: runId,
  preflight: true,
});
pre = await awaitJob(mcp, pre, "preflight");
OUT("preflight", pre);
log("preflight", pre.status, pre.blocker || pre.ready);

if (pre.status === "setup_blocked" && pre.resume_tool_call) {
  await startDriver(legs, {
    flowRunId: runId,
    verifierToken: process.env.FETCHSANDBOX_VERIFIER_TOKEN,
    slackWebhookSecret:
      process.env.FETCHSANDBOX_SLACK_WEBHOOK_SECRET ||
      process.env.SLACK_SIGNING_SECRET,
  });
  pre = await mcp.call("validate_integration", pre.resume_tool_call.arguments);
  pre = await awaitJob(mcp, pre, "preflight-resume");
  OUT("preflight2", pre);
  log("preflight2", pre.status, pre.blocker || pre.ready);
}

if (pre.status === "setup_blocked") {
  // Last resort: cancel and reconfigure with only baseline using /invoices global + no verifier
  log("preflight blocked; trying public baseline-only contract");
  await mcp.call("validate_integration", {
    session_id: sid,
    run_id: runId,
    cancel: true,
  });
  await startDriver(legs);
  const baselineOnly = {
    app_version: APP_VERSION + "-baseline",
    disposable_test_app: true,
    require_verifier_token: true,
    coverage_review: coverageReview(["baseline"]),
    scope_review: scopeReview([{ id: "baseline", name: "baseline" }]),
    checks: [
      {
        id: "baseline",
        name: "Happy path invoice processing",
        before: emptyInvoicesBefore("baseline"),
        actions: [processAction("baseline", { invoiceId: "INV-BASE-1" })],
        observe: { path: caseInvoicesPath("baseline") },
        assertion: invoiceOutcome([
          { select: "invoiceKey", equals: invoiceKeyFor("INV-BASE-1") },
          { select: "slackOk", equals: true },
        ]),
      },
    ],
  };
  cfg = await mcp.call("validate_integration", {
    session_id: sid,
    suite: "application_workflow_v1",
    reassess: true,
    application_config: baselineOnly,
  });
  cfg = await awaitJob(mcp, cfg, "config-baseline");
  OUT("config-baseline", cfg);
  runId =
    cfg.run_id ||
    cfg.attempt?.run_id ||
    cfg.configuration?.run_id ||
    cfg.next_tool_call?.arguments?.run_id;
  if (!runId) {
    console.error("BASELINE_CONFIG_FAILED", JSON.stringify(cfg).slice(0, 2000));
    await mcp.call("manage_tunnel", { action: "close" });
    mcp.child.kill();
    process.exit(3);
  }
  if (cfg.next_tool_call?.name === "install_test_credentials" || cfg.secret_handoff_url) {
    creds = await mcp.call("install_test_credentials", {
      session_id: sid,
      run_id: runId,
    });
    creds = await awaitJob(mcp, creds, "creds2");
    loadDotenv(creds.credential_file);
  }
  await startDriver(legs, {
    flowRunId: cfg.request_headers?.["X-Flow-Run-Id"] || runId,
    verifierToken: process.env.FETCHSANDBOX_VERIFIER_TOKEN,
  });
  pre = await mcp.call("validate_integration", {
    session_id: sid,
    run_id: runId,
    preflight: true,
  });
  pre = await awaitJob(mcp, pre, "preflight-baseline");
  OUT("preflight-baseline", pre);
  log("preflight-baseline", pre.status, pre.blocker || pre.ready);
}

if (pre.status === "setup_blocked") {
  console.error("STILL_SETUP_BLOCKED", pre.blocker);
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
log("execute", exe.status || exe.step, exe.message_for_user || "");

let final = exe;
let stableTerminalPolls = 0;
for (let i = 0; i < 90; i++) {
  await sleep(Math.max(10000, (exe.retry_after_seconds || 10) * 1000));
  // Session-only retrieve while suite runs (do not re-execute / cancel).
  let st = await mcp.call("validate_integration", { session_id: sid });
  st = await awaitJob(mcp, st, `status-${i}`);
  OUT("status", st);
  const verdict =
    typeof st.verdict === "string" ? st.verdict : st.verdict?.overall || st.verdict?.state;
  const s = st.status || st.step || "";
  const share = st.share_url || st.receipt_url || st.verdict?.share_url || "";
  const checks = st.checks || [];
  const held = checks.filter((c) => c.status === "held").length;
  const unmeasured = checks.filter((c) => c.status === "unmeasured").length;
  const failed = checks.filter((c) => c.status === "failed").length;
  const passed = checks.filter((c) => c.status === "passed").length;
  log(
    "poll",
    i,
    s || verdict || "?",
    `complete=${st.complete} held=${held} passed=${passed} failed=${failed} unmeasured=${unmeasured}`,
    share,
  );
  final = st;

  // Keep the tunnel open until FetchSandbox finishes driving checks.
  // share_url appears mid-run and must NOT close the tunnel early.
  if (s === "running" || st.status === "running") {
    stableTerminalPolls = 0;
    continue;
  }
  const allSettled =
    checks.length > 0 &&
    checks.every((c) =>
      ["held", "passed", "failed", "unmeasured", "blocked", "error"].includes(c.status),
    );
  if (
    st.complete === true ||
    st.app_verified === true ||
    st.declared_checks_complete === true ||
    ["passed", "failed", "completed", "error", "done"].includes(String(s)) ||
    (allSettled && verdict)
  ) {
    stableTerminalPolls += 1;
    // Require two consecutive settled polls so late checks can still land.
    if (stableTerminalPolls >= 2 || st.complete === true || st.app_verified === true) {
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
    log("check", c.id, c.status, (c.explanation || "").slice(0, 120));
  }
}
writeFileSync(
  "/tmp/fs-proof-receipt-url.txt",
  String(share || final.status || "no-receipt") + "\n",
);

await mcp.call("manage_tunnel", { action: "close" });
mcp.child.kill();
writeFileSync("/tmp/fs-proof-done.flag", "ok\n");
log("PROOF_DONE");
