import { type ProviderEndpoint, ProviderHttp } from "../kit/http";
import { CalendarClient, GmailClient } from "./google";
import { HubSpotClient } from "./hubspot";
import { SlackClient } from "./slack";
import { StripeClient } from "./stripe";
import { ZendeskClient } from "./zendesk";

export type ProviderName = "stripe" | "hubspot" | "gmail" | "calendar" | "slack" | "zendesk";
export const PROVIDERS: ProviderName[] = ["stripe", "hubspot", "gmail", "calendar", "slack", "zendesk"];

/** Clients for one run. A provider that isn't configured is absent, never faked. */
export interface Providers {
  stripe?: StripeClient;
  hubspot?: HubSpotClient;
  gmail?: GmailClient;
  calendar?: CalendarClient;
  slack?: SlackClient;
  zendesk?: ZendeskClient;
}

const DEFAULT_BASE: Record<ProviderName, string | undefined> = {
  stripe: "https://api.stripe.com",
  hubspot: "https://api.hubapi.com",
  gmail: "https://gmail.googleapis.com",
  calendar: "https://www.googleapis.com",
  slack: "https://slack.com",
  zendesk: undefined, // https://<subdomain>.zendesk.com — set ZENDESK_BASE_URL or ZENDESK_SUBDOMAIN
};

// Env var prefix per provider. Calendar also answers to GOOGLE_CALENDAR_*.
const PREFIX: Record<ProviderName, string[]> = {
  stripe: ["STRIPE"],
  hubspot: ["HUBSPOT"],
  gmail: ["GMAIL"],
  calendar: ["GCAL", "GOOGLE_CALENDAR"],
  slack: ["SLACK"],
  zendesk: ["ZENDESK"],
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
    if (!token || !baseUrl) continue;
    const endpoint: ProviderEndpoint = { provider: p, baseUrl, token };
    if (p === "zendesk" && env.ZENDESK_EMAIL) {
      endpoint.authorization = `Basic ${Buffer.from(`${env.ZENDESK_EMAIL}/token:${token}`).toString("base64")}`;
    }
    out[p] = endpoint;
  }
  return out;
}

export type ProviderFactory = (headers: Record<string, string>) => Providers;

/** Builds per-run clients that stamp `headers` (e.g. X-Flow-Run-Id) on every provider request. */
export function providerFactory(endpoints: Partial<Record<ProviderName, ProviderEndpoint>>): ProviderFactory {
  return (headers) => {
    const http = (p: ProviderName) => (endpoints[p] ? new ProviderHttp(endpoints[p]!, headers) : undefined);
    const h = Object.fromEntries(PROVIDERS.map((p) => [p, http(p)])) as Record<ProviderName, ProviderHttp | undefined>;
    return {
      stripe: h.stripe && new StripeClient(h.stripe),
      hubspot: h.hubspot && new HubSpotClient(h.hubspot),
      gmail: h.gmail && new GmailClient(h.gmail),
      calendar: h.calendar && new CalendarClient(h.calendar),
      slack: h.slack && new SlackClient(h.slack),
      zendesk: h.zendesk && new ZendeskClient(h.zendesk),
    };
  };
}
