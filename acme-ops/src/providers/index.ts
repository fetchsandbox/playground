import { zendeskAuthorization } from "./zendesk-oauth";
import { type ProviderEndpoint, ProviderHttp } from "../kit/http";
import { EasyPostClient, GustoClient, NetSuiteClient, OpenAIClient, PlaidClient, ShopifyClient, TwilioVerifyClient } from "./commerce";
import { CalendarClient, GmailClient } from "./google";
import { HubSpotClient } from "./hubspot";
import { SlackClient } from "./slack";
import { SquareClient } from "./square";
import { StripeClient } from "./stripe";
import { AsanaClient, BoxClient, DatadogClient, GitHubClient, NotionClient, PagerDutyClient, ScreeningClient, TwilioClient, WorkOSClient } from "./work";
import { ZendeskClient } from "./zendesk";

export type ProviderName =
  | "stripe"
  | "hubspot"
  | "gmail"
  | "calendar"
  | "slack"
  | "zendesk"
  | "asana"
  | "workos"
  | "github"
  | "twilio"
  | "pagerduty"
  | "notion"
  | "box"
  | "screening"
  | "square"
  | "openai"
  | "shopify"
  | "netsuite"
  | "easypost"
  | "plaid"
  | "twilio_verify"
  | "gusto"
  | "datadog";
export const PROVIDERS: ProviderName[] = ["stripe", "hubspot", "gmail", "calendar", "slack", "zendesk", "asana", "workos", "github", "twilio", "pagerduty", "notion", "box", "screening", "square", "openai", "shopify", "netsuite", "easypost", "plaid", "twilio_verify", "gusto", "datadog"];

/** Clients for one run. A provider that isn't configured is absent, never faked. */
export interface Providers {
  stripe?: StripeClient;
  hubspot?: HubSpotClient;
  gmail?: GmailClient;
  calendar?: CalendarClient;
  slack?: SlackClient;
  zendesk?: ZendeskClient;
  asana?: AsanaClient;
  workos?: WorkOSClient;
  github?: GitHubClient;
  twilio?: TwilioClient;
  pagerduty?: PagerDutyClient;
  notion?: NotionClient;
  box?: BoxClient;
  /** Restricted-party screening (Trade.gov Consolidated Screening List). */
  screening?: ScreeningClient;
  /** Gift cards (Square Gift Cards API). */
  square?: SquareClient;
  /** Language model (OpenAI Chat Completions). */
  openai?: OpenAIClient;
  /** Storefront orders and fulfillments (Shopify Admin REST). */
  shopify?: ShopifyClient;
  /** ERP sales orders (NetSuite SuiteTalk REST). */
  netsuite?: NetSuiteClient;
  /** Shipping labels and tracking (EasyPost). */
  easypost?: EasyPostClient;
  /** Bank account ownership (Plaid Identity Match). */
  plaid?: PlaidClient;
  /** Phone callbacks with one-time codes (Twilio Verify). */
  twilio_verify?: TwilioVerifyClient;
  /** Payroll and terminations (Gusto Embedded). */
  gusto?: GustoClient;
  /** Monitors and metrics (Datadog). */
  datadog?: DatadogClient;
}

const DEFAULT_BASE: Record<ProviderName, string | undefined> = {
  stripe: "https://api.stripe.com",
  hubspot: "https://api.hubapi.com",
  gmail: "https://gmail.googleapis.com",
  calendar: "https://www.googleapis.com",
  slack: "https://slack.com",
  zendesk: undefined, // https://<subdomain>.zendesk.com — set ZENDESK_BASE_URL or ZENDESK_SUBDOMAIN
  asana: "https://app.asana.com/api/1.0",
  workos: "https://api.workos.com",
  github: "https://api.github.com",
  twilio: "https://api.twilio.com",
  pagerduty: "https://api.pagerduty.com",
  notion: "https://api.notion.com",
  box: "https://api.box.com/2.0",
  screening: "https://data.trade.gov",
  square: "https://connect.squareup.com",
  openai: "https://api.openai.com/v1",
  shopify: undefined, // https://<shop>.myshopify.com — set SHOPIFY_BASE_URL
  netsuite: undefined, // https://<account>.suitetalk.api.netsuite.com — set NETSUITE_BASE_URL
  easypost: "https://api.easypost.com/v2",
  plaid: "https://production.plaid.com",
  twilio_verify: "https://verify.twilio.com",
  gusto: "https://api.gusto.com",
  datadog: "https://api.datadoghq.com",
};

// Env var prefix per provider. Calendar also answers to GOOGLE_CALENDAR_*.
const PREFIX: Record<ProviderName, string[]> = {
  stripe: ["STRIPE"],
  hubspot: ["HUBSPOT"],
  gmail: ["GMAIL"],
  calendar: ["GCAL", "GOOGLE_CALENDAR"],
  slack: ["SLACK"],
  zendesk: ["ZENDESK"],
  asana: ["ASANA"],
  workos: ["WORKOS"],
  github: ["GITHUB"],
  twilio: ["TWILIO"],
  pagerduty: ["PAGERDUTY"],
  notion: ["NOTION"],
  box: ["BOX"],
  screening: ["TRADE_GOV", "SCREENING"],
  square: ["SQUARE"],
  openai: ["OPENAI"],
  shopify: ["SHOPIFY", "SHOPIFY_ADMIN"],
  netsuite: ["NETSUITE"],
  easypost: ["EASYPOST"],
  plaid: ["PLAID"],
  twilio_verify: ["TWILIO_VERIFY"],
  gusto: ["GUSTO"],
  datadog: ["DATADOG", "DD"],
};

function pick(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const n of names) if (env[n]) return env[n];
  return undefined;
}

/**
 * Endpoint for each configured provider:
 *   <P>_BASE_URL  — optional; defaults to the vendor's production API
 *   <P>_API_KEY   — bearer token (Stripe secret key, HubSpot private-app token,
 *                   Google OAuth access token, Slack bot token, Zendesk OAuth token)
 *   ZENDESK_EMAIL — switches Zendesk to API-token auth ("<email>/token:<key>")
 */
export function endpointsFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<Record<ProviderName, ProviderEndpoint>> {
  const out: Partial<Record<ProviderName, ProviderEndpoint>> = {};
  for (const p of PROVIDERS) {
    const token = pick(env, PREFIX[p].flatMap((x) => [`${x}_API_KEY`, `${x}_TOKEN`]));
    let baseUrl = pick(env, PREFIX[p].map((x) => `${x}_BASE_URL`)) ?? DEFAULT_BASE[p];
    if (p === "zendesk" && !baseUrl && env.ZENDESK_SUBDOMAIN) baseUrl = `https://${env.ZENDESK_SUBDOMAIN}.zendesk.com`;
    const zendeskOauth = p === "zendesk" && baseUrl === `https://${env.ZENDESK_SUBDOMAIN}.zendesk.com` && env.ZENDESK_SUBDOMAIN && env.ZENDESK_CLIENT_ID && env.ZENDESK_CLIENT_SECRET && env.ZENDESK_SCOPES;
    if ((!token && !zendeskOauth) || !baseUrl) continue;
    const endpoint: ProviderEndpoint = { provider: p, baseUrl, token: token ?? "" };
    if (zendeskOauth) endpoint.getAuthorization = zendeskAuthorization(baseUrl, env.ZENDESK_CLIENT_ID!, env.ZENDESK_CLIENT_SECRET!, env.ZENDESK_SCOPES!);
    if (!zendeskOauth && p === "zendesk" && env.ZENDESK_EMAIL) {
      endpoint.authorization = `Basic ${Buffer.from(`${env.ZENDESK_EMAIL}/token:${token}`).toString("base64")}`;
    }
    // Vendor auth dialects, applied only against the vendor's own host (twins take Bearer).
    if (p === "twilio" && baseUrl === DEFAULT_BASE.twilio) {
      endpoint.authorization = `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID ?? ""}:${token}`).toString("base64")}`;
    }
    if (p === "pagerduty" && baseUrl === DEFAULT_BASE.pagerduty) endpoint.authorization = `Token token=${token}`;
    if (p === "easypost" && baseUrl === DEFAULT_BASE.easypost) endpoint.authorization = `Basic ${Buffer.from(`${token}:`).toString("base64")}`;
    out[p] = endpoint;
  }
  return out;
}

export type ProviderFactory = (headers: Record<string, string>) => Providers;

/** Headers some vendors require on every call. */
const VENDOR_HEADERS: Partial<Record<ProviderName, Record<string, string>>> = {
  notion: { "Notion-Version": "2022-06-28" },
  github: { "X-GitHub-Api-Version": "2022-11-28" },
  square: { "Square-Version": "2025-01-23" },
};

/** Builds per-run clients that stamp `headers` (e.g. X-Flow-Run-Id) on every provider request. */
export function providerFactory(endpoints: Partial<Record<ProviderName, ProviderEndpoint>>, env: NodeJS.ProcessEnv = process.env): ProviderFactory {
  return (headers) => {
    const http = (p: ProviderName) => (endpoints[p] ? new ProviderHttp(endpoints[p]!, { ...VENDOR_HEADERS[p], ...headers }) : undefined);
    const h = Object.fromEntries(PROVIDERS.map((p) => [p, http(p)])) as Record<ProviderName, ProviderHttp | undefined>;
    return {
      stripe: h.stripe && new StripeClient(h.stripe),
      hubspot: h.hubspot && new HubSpotClient(h.hubspot),
      gmail: h.gmail && new GmailClient(h.gmail),
      calendar: h.calendar && new CalendarClient(h.calendar),
      slack: h.slack && new SlackClient(h.slack),
      zendesk: h.zendesk && new ZendeskClient(h.zendesk),
      asana: h.asana && new AsanaClient(h.asana),
      workos: h.workos && new WorkOSClient(h.workos),
      github: h.github && new GitHubClient(h.github),
      twilio: h.twilio && new TwilioClient(h.twilio, env.TWILIO_ACCOUNT_SID ?? "AC_ACME_DEMO"),
      pagerduty: h.pagerduty && new PagerDutyClient(h.pagerduty, env.PAGERDUTY_FROM_EMAIL ?? "ops-bot@acme.example"),
      notion: h.notion && new NotionClient(h.notion),
      box: h.box && new BoxClient(h.box),
      screening: h.screening && new ScreeningClient(h.screening),
      square: h.square && new SquareClient(h.square),
      openai: h.openai && new OpenAIClient(h.openai, env.OPENAI_MODEL ?? "gpt-4o-mini"),
      shopify: h.shopify && new ShopifyClient(h.shopify, env.SHOPIFY_API_VERSION ?? "2024-10"),
      netsuite: h.netsuite && new NetSuiteClient(h.netsuite),
      easypost: h.easypost && new EasyPostClient(h.easypost),
      plaid: h.plaid && new PlaidClient(h.plaid, env.PLAID_CLIENT_ID ?? "", env.PLAID_SECRET ?? ""),
      twilio_verify: h.twilio_verify && new TwilioVerifyClient(h.twilio_verify, env.TWILIO_VERIFY_SERVICE_SID ?? "VA_ACME_DEMO"),
      gusto: h.gusto && new GustoClient(h.gusto, env.GUSTO_COMPANY_ID ?? "acme-company"),
      datadog: h.datadog && new DatadogClient(h.datadog, env.DATADOG_APP_KEY ?? env.DD_APPLICATION_KEY ?? ""),
    };
  };
}
