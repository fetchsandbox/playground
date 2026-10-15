#!/usr/bin/env node
/**
 * Disposable HTTP driver for FetchSandbox managed-tunnel verification.
 * Exercises the SAME provider REST contracts as invoice-watch
 * (Gmail users.messages.list, Calendar events.insert, Slack chat.postMessage)
 * against FetchSandbox twin base URLs, and exposes readable state for
 * application_workflow_v1 before/observe assertions.
 *
 * Env:
 *   SLACK_BASE_URL, SLACK_API_KEY
 *   GMAIL_BASE_URL, GMAIL_API_KEY
 *   GCAL_BASE_URL, GCAL_API_KEY
 *   X_FLOW_RUN_ID (optional)
 *   SLACK_CHANNEL (default C0BILLING01)
 *   FETCHSANDBOX_VERIFIER_TOKEN (optional; required when set)
 *   SLACK_SIGNING_SECRET / FETCHSANDBOX_SLACK_WEBHOOK_SECRET (optional)
 *   PORT (default 8788)
 */
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 8788);
const flowHeaders = process.env.X_FLOW_RUN_ID
  ? { "X-Flow-Run-Id": process.env.X_FLOW_RUN_ID }
  : {};
const VERIFIER_TOKEN = process.env.FETCHSANDBOX_VERIFIER_TOKEN || "";
const SLACK_SIGNING_SECRET =
  process.env.FETCHSANDBOX_SLACK_WEBHOOK_SECRET ||
  process.env.SLACK_SIGNING_SECRET ||
  "";

/** @type {{ last: any, invoices: any[], runs: Record<string, any[]>, cases: Record<string, any[]>, webhooks: any[], caseWebhooks: Record<string, any[]>, effects: any[] }} */
const state = {
  last: null,
  invoices: [],
  runs: {},
  /** Per-check isolation: `${runId}::${caseId}` → invoice records */
  cases: {},
  webhooks: [],
  caseWebhooks: {},
  effects: [],
};

function requireVerifier(req, res) {
  if (!VERIFIER_TOKEN) return true;
  const auth = req.headers.authorization || "";
  const ok =
    auth === `Bearer ${VERIFIER_TOKEN}` || auth === `bearer ${VERIFIER_TOKEN}`;
  if (!ok) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "unauthorized" }));
    return false;
  }
  return true;
}

function joinTwinUrl(baseUrl, path) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const rel = String(path || "").replace(/^\/+/, "");
  return `${base}/${rel}`;
}

async function providerFetch(baseUrl, apiKey, path, { method = "GET", body } = {}) {
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
  return { status: res.status, json, url, method, requestBody: body };
}

function caseKey(runId, caseId) {
  if (!runId || !caseId) return null;
  return `${runId}::${caseId}`;
}

function invoiceCollection(runId, caseId) {
  const ck = caseKey(runId, caseId);
  if (ck) return state.cases[ck] || [];
  if (runId) return state.runs[String(runId)] || [];
  return state.invoices;
}

function pushInvoice(runId, summary, caseId) {
  state.invoices.push(summary);
  if (runId) {
    const key = String(runId);
    if (!state.runs[key]) state.runs[key] = [];
    state.runs[key].push(summary);
  }
  const ck = caseKey(runId, caseId);
  if (ck) {
    if (!state.cases[ck]) state.cases[ck] = [];
    state.cases[ck].push(summary);
  }
}

async function runInvoiceWorkflow(input = {}) {
  const merchant = input.merchant || "Notion";
  const amount = input.amount || "$29.00 USD";
  const cancelBy = input.cancelBy || "2026-11-12";
  const renewalDate = input.renewalDate || "2026-11-15";
  const invoiceId = input.invoiceId || "INV-1001";
  const channel = input.channel || process.env.SLACK_CHANNEL || "C0BILLING01";
  const runId = input.run_id || null;
  const caseId = input.case_id || null;
  const invoiceKey = `${merchant}|${invoiceId}|${amount}`.toLowerCase();

  // Dedupe within case/run scope (and global list)
  const existing = invoiceCollection(runId, caseId).find(
    (r) => r.invoiceKey === invoiceKey,
  );
  if (existing) {
    const record = {
      ...existing,
      deduped: true,
      at: new Date().toISOString(),
    };
    state.last = record;
    return record;
  }

  const gmailQ = "subject:invoice newer_than:7d";
  const steps = {};

  steps.gmail = await providerFetch(
    process.env.GMAIL_BASE_URL,
    process.env.GMAIL_API_KEY,
    `/gmail/v1/users/me/messages?q=${encodeURIComponent(gmailQ)}&maxResults=20`,
  );

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
          runId ? `Run: ${runId}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        visibility: "private",
        start: { dateTime: `${cancelBy}T09:00:00` },
        end: { dateTime: `${cancelBy}T10:00:00` },
      },
    },
  );

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

  const slackOk = steps.slack.json?.ok === true;
  const calendarOk = steps.calendar.status >= 200 && steps.calendar.status < 300;
  const gmailOk = steps.gmail.status >= 200 && steps.gmail.status < 300;

  const summary = {
    invoiceKey,
    merchant,
    amount,
    slackOk,
    calendarOk,
    gmailOk,
    calendarEventId: steps.calendar.json?.id || null,
    slackTs: steps.slack.json?.ts || null,
    slackError: steps.slack.json?.error || null,
    runId,
    caseId,
    status:
      slackOk && calendarOk
        ? "processed"
        : slackOk || calendarOk
          ? "partial"
          : "failed",
  };

  // Only record successful or partial effects that touched providers;
  // full auth failures still get a failed record for observation.
  pushInvoice(runId, summary, caseId);
  state.effects.push({
    kind: "invoice_process",
    invoiceKey,
    runId,
    slackOk,
    calendarOk,
    at: new Date().toISOString(),
  });

  const record = {
    ...summary,
    steps,
    deduped: false,
    at: new Date().toISOString(),
  };
  state.last = record;
  return record;
}

function bearerMatchesVerifier(headers) {
  if (!VERIFIER_TOKEN) return false;
  const auth = headers.authorization || "";
  return (
    auth === `Bearer ${VERIFIER_TOKEN}` || auth === `bearer ${VERIFIER_TOKEN}`
  );
}

/** Strict Slack Events signing (production dialect). */
function verifySlackSignature(rawBody, headers) {
  if (!SLACK_SIGNING_SECRET) return { ok: true, skipped: true };
  const timestamp = headers["x-slack-request-timestamp"];
  const signature = headers["x-slack-signature"];
  if (!timestamp || !signature) return { ok: false, reason: "missing_signature" };
  const base = `v0:${timestamp}:${rawBody}`;
  const digest =
    "v0=" +
    crypto.createHmac("sha256", SLACK_SIGNING_SECRET).update(base).digest("hex");
  const a = Buffer.from(digest);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true, via: "slack_signature" };
}

/**
 * FetchSandbox direct event delivery authenticates with the run verifier
 * Bearer (+ X-Flow-Run-Id) rather than Slack signing headers. Keep that on a
 * dedicated route so /webhooks/slack can still prove unsigned rejection.
 */
function verifyFetchSandboxEventDelivery(headers) {
  if (!bearerMatchesVerifier(headers)) {
    return { ok: false, reason: "missing_verifier" };
  }
  return { ok: true, via: "verifier_bearer" };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        flowHeader: !!process.env.X_FLOW_RUN_ID,
        verifierRequired: !!VERIFIER_TOKEN,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/state") {
      if (!requireVerifier(req, res)) return;
      sendJson(res, 200, state);
      return;
    }

    // Keyed collections so FetchSandbox can use select:"invoices[*]" /
    // select:"webhooks[*]" for empty starting-state and outcome asserts.
    if (req.method === "GET" && url.pathname === "/invoices") {
      if (!requireVerifier(req, res)) return;
      sendJson(res, 200, { invoices: state.invoices });
      return;
    }

    const caseInvoices = url.pathname.match(
      /^\/runs\/([^/]+)\/cases\/([^/]+)\/invoices$/,
    );
    if (req.method === "GET" && caseInvoices) {
      if (!requireVerifier(req, res)) return;
      const runId = decodeURIComponent(caseInvoices[1]);
      const caseId = decodeURIComponent(caseInvoices[2]);
      sendJson(res, 200, {
        invoices: state.cases[caseKey(runId, caseId)] || [],
      });
      return;
    }

    const runInvoices = url.pathname.match(/^\/runs\/([^/]+)\/invoices$/);
    if (req.method === "GET" && runInvoices) {
      if (!requireVerifier(req, res)) return;
      const runId = decodeURIComponent(runInvoices[1]);
      sendJson(res, 200, { invoices: state.runs[runId] || [] });
      return;
    }

    if (req.method === "GET" && url.pathname === "/webhooks") {
      if (!requireVerifier(req, res)) return;
      sendJson(res, 200, { webhooks: state.webhooks });
      return;
    }

    const caseWebhooks = url.pathname.match(
      /^\/runs\/([^/]+)\/cases\/([^/]+)\/webhooks$/,
    );
    if (req.method === "GET" && caseWebhooks) {
      if (!requireVerifier(req, res)) return;
      const runId = decodeURIComponent(caseWebhooks[1]);
      const caseId = decodeURIComponent(caseWebhooks[2]);
      sendJson(res, 200, {
        webhooks: state.caseWebhooks[caseKey(runId, caseId)] || [],
      });
      return;
    }

    const runWebhooks = url.pathname.match(/^\/runs\/([^/]+)\/webhooks$/);
    if (req.method === "GET" && runWebhooks) {
      if (!requireVerifier(req, res)) return;
      const runId = decodeURIComponent(runWebhooks[1]);
      sendJson(res, 200, {
        webhooks: state.webhooks.filter((w) => w.runId === runId || !w.runId),
      });
      return;
    }

    // Legacy alias
    if (req.method === "GET" && url.pathname === "/processed") {
      if (!requireVerifier(req, res)) return;
      sendJson(res, 200, { invoices: state.invoices });
      return;
    }

    if (req.method === "POST" && url.pathname === "/process-invoice") {
      const raw = await readBody(req);
      let body = {};
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: "invalid_json" });
          return;
        }
      }
      const result = await runInvoiceWorkflow(body);
      sendJson(res, 200, { ok: true, result });
      return;
    }

    async function handleSlackWebhook(req, res, { auth }) {
      const raw = await readBody(req);
      const gate =
        auth === "slack_signature"
          ? verifySlackSignature(raw, req.headers)
          : verifyFetchSandboxEventDelivery(req.headers);
      if (!gate.ok) {
        console.error(
          "webhook/slack reject",
          gate.reason,
          "auth=",
          auth,
          "hasSig=",
          !!req.headers["x-slack-signature"],
          "hasAuth=",
          !!req.headers.authorization,
          "hasFlow=",
          !!req.headers["x-flow-run-id"],
          "bodyLen=",
          raw.length,
        );
        sendJson(res, 400, { error: gate.reason || "invalid_signature" });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(raw || "{}");
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }

      if (payload.type === "url_verification" && payload.challenge) {
        state.webhooks.push({
          provider: "slack",
          type: "url_verification",
          ok: true,
          at: new Date().toISOString(),
        });
        sendJson(res, 200, { challenge: payload.challenge });
        return;
      }

      const eventType =
        payload.event?.type || payload.type || payload.event_type || "unknown";
      const eventId =
        payload.event_id ||
        payload.event?.event_id ||
        payload.event?.client_msg_id ||
        payload.event?.ts ||
        null;
      const replay = state.webhooks.some(
        (w) => w.provider === "slack" && w.eventId && w.eventId === eventId,
      );

      const whRunId =
        payload.run_id ||
        payload.event?.run_id ||
        req.headers["x-flow-run-id"] ||
        null;
      // case_id may live on the envelope, inner event, or a text marker
      // `case:<id>` that survives FetchSandbox event wrapping.
      const text = String(payload.event?.text || payload.text || "");
      const textCase = (text.match(/\bcase:([a-z0-9_]+)\b/i) || [])[1] || null;
      const whCaseId =
        payload.case_id ||
        payload.event?.case_id ||
        payload.event?.metadata?.case_id ||
        textCase ||
        null;
      const entry = {
        provider: "slack",
        type: eventType,
        eventId: eventId || null,
        replay,
        runId: whRunId,
        caseId: whCaseId,
        ok: !replay,
        via: gate.via || auth,
        at: new Date().toISOString(),
      };
      state.webhooks.push(entry);
      const whCk = caseKey(whRunId, whCaseId);
      if (whCk) {
        if (!state.caseWebhooks[whCk]) state.caseWebhooks[whCk] = [];
        state.caseWebhooks[whCk].push(entry);
      }

      if (replay) {
        sendJson(res, 200, { ok: true, deduped: true });
        return;
      }
      sendJson(res, 200, { ok: true });
    }

    // Production Slack Events route — strict signature (unsigned → 400).
    if (req.method === "POST" && url.pathname === "/webhooks/slack") {
      await handleSlackWebhook(req, res, { auth: "slack_signature" });
      return;
    }

    // FetchSandbox direct event destination — verifier Bearer auth.
    if (req.method === "POST" && url.pathname === "/webhooks/slack/fs") {
      await handleSlackWebhook(req, res, { auth: "verifier_bearer" });
      return;
    }

    // Generic provider event sink (Calendar/Gmail push-style)
    if (req.method === "POST" && url.pathname === "/webhooks/google") {
      const raw = await readBody(req);
      let payload = {};
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
      const eventId = payload.id || payload.message?.messageId || null;
      const replay = eventId
        ? state.webhooks.some((w) => w.provider === "google" && w.eventId === eventId)
        : false;
      state.webhooks.push({
        provider: "google",
        type: payload.type || payload.eventType || "notification",
        eventId,
        replay,
        ok: !replay,
        at: new Date().toISOString(),
      });
      sendJson(res, replay ? 200 : 200, { ok: true, deduped: replay });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (err) {
    sendJson(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`twin-driver listening on http://127.0.0.1:${PORT}`);
});
