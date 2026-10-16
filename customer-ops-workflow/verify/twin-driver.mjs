#!/usr/bin/env node
/**
 * Optional standalone twin smoker (no managed tunnel).
 * Hits Stripe / HubSpot / Gmail / Slack twin REST paths with the same shapes
 * the Python agents use. Prefer `run-proof-receipt.mjs` for full verification.
 *
 * Env: STRIPE_API_BASE, STRIPE_API_KEY, HUBSPOT_API_BASE, HUBSPOT_ACCESS_TOKEN,
 *      GMAIL_API_BASE, GMAIL_ACCESS_TOKEN, SLACK_API_BASE, SLACK_BOT_TOKEN,
 *      X_FLOW_RUN_ID (optional)
 */
import crypto from "node:crypto";

function joinTwinUrl(baseUrl, path) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const rel = String(path || "").replace(/^\/+/, "");
  return `${base}/${rel}`;
}

const flowHeaders = process.env.X_FLOW_RUN_ID
  ? { "X-Flow-Run-Id": process.env.X_FLOW_RUN_ID }
  : {};

async function providerFetch(baseUrl, apiKey, path, { method = "GET", body, form } = {}) {
  const url = joinTwinUrl(baseUrl, path);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "User-Agent": "customer-ops-twin-driver/0.1",
    ...flowHeaders,
  };
  let payload;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
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
  return { status: res.status, json, url, method };
}

async function main() {
  const email = process.env.CUSTOMER_EMAIL || "ada@example.test";
  const channel = process.env.SLACK_CHANNEL || "C0OPS01";
  const steps = {};

  steps.stripeCustomer = await providerFetch(
    process.env.STRIPE_API_BASE,
    process.env.STRIPE_API_KEY,
    "/v1/customers",
    { method: "POST", form: { email, name: "Ada Lovelace" } },
  );
  const customerId = steps.stripeCustomer.json?.id;
  steps.stripePaymentIntent = await providerFetch(
    process.env.STRIPE_API_BASE,
    process.env.STRIPE_API_KEY,
    "/v1/payment_intents",
    {
      method: "POST",
      form: {
        customer: customerId,
        amount: "267300",
        currency: "usd",
        confirm: "false",
        receipt_email: email,
        description: "customer-ops twin smoke",
        "metadata[workflow_id]": `wf_smoke_${crypto.randomBytes(4).toString("hex")}`,
      },
    },
  );

  steps.hubspotContact = await providerFetch(
    process.env.HUBSPOT_API_BASE,
    process.env.HUBSPOT_ACCESS_TOKEN || process.env.HUBSPOT_API_KEY,
    "/crm/v3/objects/contacts",
    {
      method: "POST",
      body: {
        properties: {
          email,
          firstname: "Ada",
          lastname: "Lovelace",
          company: "Acme Analytics",
        },
      },
    },
  );
  const contactId = steps.hubspotContact.json?.id;
  steps.hubspotDeal = await providerFetch(
    process.env.HUBSPOT_API_BASE,
    process.env.HUBSPOT_ACCESS_TOKEN || process.env.HUBSPOT_API_KEY,
    "/crm/v3/objects/deals",
    {
      method: "POST",
      body: {
        properties: {
          dealname: "Acme Analytics — pro_annual",
          amount: "2673.00",
          dealstage: "appointmentscheduled",
        },
        associations: contactId
          ? [
              {
                to: { id: contactId },
                types: [
                  {
                    associationCategory: "HUBSPOT_DEFINED",
                    associationTypeId: 3,
                  },
                ],
              },
            ]
          : [],
      },
    },
  );

  const raw = Buffer.from(
    `To: ${email}\r\nFrom: ops@example.test\r\nSubject: twin smoke\r\n\r\nhello\r\n`,
  ).toString("base64url");
  steps.gmail = await providerFetch(
    process.env.GMAIL_API_BASE,
    process.env.GMAIL_ACCESS_TOKEN || process.env.GMAIL_API_KEY,
    "/gmail/v1/users/me/messages/send",
    { method: "POST", body: { raw } },
  );

  const slackBase = process.env.SLACK_API_BASE || "";
  const slackPath = slackBase.replace(/\/+$/, "").endsWith("/api")
    ? "chat.postMessage"
    : "api/chat.postMessage";
  steps.slack = await providerFetch(
    slackBase,
    process.env.SLACK_BOT_TOKEN || process.env.SLACK_API_KEY,
    slackPath,
    {
      method: "POST",
      body: {
        channel,
        text: `customer-ops twin smoke for ${email}`,
        unfurl_links: false,
        unfurl_media: false,
      },
    },
  );

  const summary = {
    stripeOk: steps.stripePaymentIntent.status < 300,
    hubspotOk: steps.hubspotDeal.status < 300,
    gmailOk: steps.gmail.status < 300,
    slackOk: steps.slack.json?.ok === true,
    steps,
  };
  console.log(JSON.stringify(summary, null, 2));
  const ok =
    summary.stripeOk && summary.hubspotOk && summary.gmailOk && summary.slackOk;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
