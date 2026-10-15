#!/usr/bin/env node
/**
 * Disposable HTTP driver for FetchSandbox managed-tunnel / caller-executed
 * verification. Exercises the SAME provider REST contracts that invoice-watch
 * encodes (Gmail users.messages.list, Calendar events.insert, Slack
 * chat.postMessage) against FetchSandbox twin base URLs.
 *
 * Env (from validate_integration legs + arm):
 *   SLACK_BASE_URL, SLACK_API_KEY
 *   GMAIL_BASE_URL, GMAIL_API_KEY
 *   GCAL_BASE_URL, GCAL_API_KEY
 *   X_FLOW_RUN_ID (optional; from arm.request_headers)
 *   SLACK_CHANNEL (default C0123456789 — override with twin conversation id)
 *   PORT (default 8788)
 */
import http from "node:http";

const PORT = Number(process.env.PORT || 8788);
const flowHeaders = process.env.X_FLOW_RUN_ID
  ? { "X-Flow-Run-Id": process.env.X_FLOW_RUN_ID }
  : {};

const state = { last: null, processed: [], runs: {} };

/** Join twin base URL + vendor path without dropping `/sandbox/<id>`. */
function joinTwinUrl(baseUrl, path) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const rel = String(path || "").replace(/^\/+/, "");
  return `${base}/${rel}`;
}

async function providerFetch(baseUrl, apiKey, path, { method = "GET", body } = {}) {
  // Paths like `/gmail/v1/...` must append under the sandbox base — `new URL('/x', base)`
  // would resolve against the origin and drop `/sandbox/<id>`.
  const url = joinTwinUrl(baseUrl, path);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    ...flowHeaders,
  };
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, url: url.toString(), method, requestBody: body };
}

/** Official contracts from bot/lib/providers/* */
async function runInvoiceWorkflow(input = {}) {
  const merchant = input.merchant || "Notion";
  const amount = input.amount || "$29.00 USD";
  const cancelBy = input.cancelBy || "2026-11-12";
  const renewalDate = input.renewalDate || "2026-11-15";
  const invoiceId = input.invoiceId || "INV-1001";
  const channel = input.channel || process.env.SLACK_CHANNEL || "C0123456789";
  const invoiceKey = `${merchant}|${invoiceId}|${amount}`.toLowerCase();

  // Twin verification uses a simple users.messages.list `q`. The agent’s
  // Gmail MCP search_threads query stays the full boolean form; FetchSandbox
  // twins currently reject grouped/boolean Gmail search with 501.
  const gmailQ = "subject:invoice newer_than:7d";

  const steps = {};

  // Gmail REST users.messages.list
  steps.gmail = await providerFetch(
    process.env.GMAIL_BASE_URL,
    process.env.GMAIL_API_KEY,
    `/gmail/v1/users/me/messages?q=${encodeURIComponent(gmailQ)}&maxResults=20`,
  );

  // Calendar REST events.insert
  steps.calendar = await providerFetch(
    process.env.GCAL_BASE_URL,
    process.env.GCAL_API_KEY,
    "/calendar/v3/calendars/primary/events",
    {
      method: "POST",
      body: {
        summary: `Cancel ${merchant} subscription`,
        description: [
          `Cancel the ${merchant} subscription before renewal.`,
          `Amount: ${amount}`,
          `Renewal: ${renewalDate}`,
          `Invoice: ${invoiceId}`,
        ].join("\n"),
        visibility: "private",
        start: { dateTime: `${cancelBy}T09:00:00` },
        end: { dateTime: `${cancelBy}T10:00:00` },
      },
    },
  );

  // Slack Web API chat.postMessage
  const text = [
    `Subscription invoice: ${merchant} — ${amount}`,
    `Renews: ${renewalDate} · Cancel by: ${cancelBy}`,
    steps.calendar.json?.id
      ? `Calendar event: ${steps.calendar.json.id}`
      : "Calendar reminder created.",
    `Invoice key: ${invoiceKey}`,
  ].join("\n");

  steps.slack = await providerFetch(
    process.env.SLACK_BASE_URL,
    process.env.SLACK_API_KEY,
    "/api/chat.postMessage",
    {
      method: "POST",
      body: {
        channel,
        text,
        unfurl_links: false,
        unfurl_media: false,
      },
    },
  );

  const record = {
    invoiceKey,
    merchant,
    amount,
    cancelBy,
    renewalDate,
    calendarEventId: steps.calendar.json?.id,
    slackOk: steps.slack.json?.ok,
    slackTs: steps.slack.json?.ts,
    slackError: steps.slack.json?.error,
    steps,
    at: new Date().toISOString(),
  };
  const summary = {
    invoiceKey,
    slackOk: record.slackOk,
    calendarEventId: record.calendarEventId,
    runId: input.run_id || null,
  };
  state.last = record;
  state.processed.push(summary);
  if (input.run_id) {
    const key = String(input.run_id);
    if (!state.runs[key]) state.runs[key] = [];
    state.runs[key].push(summary);
  }
  return record;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  res.setHeader("content-type", "application/json");

  if (req.method === "GET" && url.pathname === "/health") {
    res.end(JSON.stringify({ ok: true, flowHeader: !!process.env.X_FLOW_RUN_ID }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/state") {
    res.end(JSON.stringify(state));
    return;
  }
  // Fresh collection for FetchSandbox application_workflow_v1 before/observe.
  if (req.method === "GET" && url.pathname === "/processed") {
    res.end(JSON.stringify(state.processed));
    return;
  }
  // Per-run scoped collection: GET /runs/{{run_id}}/processed (bare array).
  const runProcessed = url.pathname.match(/^\/runs\/([^/]+)\/processed$/);
  if (req.method === "GET" && runProcessed) {
    const runId = decodeURIComponent(runProcessed[1]);
    res.end(JSON.stringify(state.runs[runId] || []));
    return;
  }
  if (req.method === "POST" && url.pathname === "/process-invoice") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    if (chunks.length) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
    }
    try {
      const result = await runInvoiceWorkflow(body);
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, result }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
    }
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`twin-driver listening on http://127.0.0.1:${PORT}`);
});
