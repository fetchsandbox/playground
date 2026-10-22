import { ProviderError } from "./errors";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ProviderEndpoint {
  provider: string;
  baseUrl: string;
  /** Sent as `Authorization: Bearer <token>` unless `authorization` overrides it. */
  token: string;
  authorization?: string;
  getAuthorization?: () => Promise<string>;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  /** Stripe-style application/x-www-form-urlencoded body (already flattened). */
  form?: Record<string, string | number | boolean | undefined>;
  /** A body sent as is (e.g. multipart uploads). */
  raw?: { body: string; contentType: string };
  /** Treat these statuses as data rather than errors (e.g. HubSpot 409). */
  allow?: number[];
  headers?: Record<string, string>;
}

export interface HttpResult<T> {
  status: number;
  body: T;
  /** Response headers, lowercased (e.g. `location` for APIs that answer 204 + Location). */
  headers?: Record<string, string>;
}

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** Pull a provider's own error code out of whatever envelope it uses. */
function providerCode(body: any, status: number): string {
  if (body && typeof body === "object") {
    if (typeof body.error === "string") return body.error; // Slack, Zendesk
    if (body.error?.code) return String(body.error.code); // Stripe, Google
    if (body.error?.type) return String(body.error.type);
    if (typeof body.category === "string") return body.category; // HubSpot
    if (Array.isArray(body.errors) && body.errors[0]?.code) return String(body.errors[0].code);
  }
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return `http_${status}`;
}

/**
 * One provider's HTTP surface. Every request carries the run's correlation
 * headers (X-Flow-Run-Id under FetchSandbox), and transient failures (429,
 * 5xx, network) are retried a couple of times with jittered backoff that
 * honours Retry-After. Anything left over is a typed ProviderError.
 */
export class ProviderHttp {
  constructor(
    readonly endpoint: ProviderEndpoint,
    private readonly headers: Record<string, string> = {},
    private readonly retries = Number(process.env.PROVIDER_RETRIES ?? 2),
    private readonly timeoutMs = Number(process.env.PROVIDER_TIMEOUT_MS ?? 15_000),
  ) {}

  get provider() {
    return this.endpoint.provider;
  }

  url(path: string, query?: RequestOptions["query"]): string {
    // An absolute URL is a vendor's second host (e.g. Box uploads); credentials still come from this endpoint.
    const u = new URL(/^https?:\/\//.test(path) ? path : this.endpoint.baseUrl.replace(/\/+$/, "") + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async request<T = any>(method: string, path: string, opts: RequestOptions = {}): Promise<HttpResult<T>> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(method, path, opts);
      } catch (err) {
        if (!(err instanceof ProviderError) || !err.retryable || attempt >= this.retries) throw err;
        const backoff = Math.random() * Math.min(4_000, 250 * 2 ** attempt);
        await sleep(Math.min(4_000, err.retryAfterMs ?? backoff));
      }
    }
  }

  private async once<T>(method: string, path: string, opts: RequestOptions): Promise<HttpResult<T>> {
    const headers: Record<string, string> = {
      authorization: this.endpoint.getAuthorization ? await this.endpoint.getAuthorization() : this.endpoint.authorization ?? `Bearer ${this.endpoint.token}`,
      accept: "application/json",
      ...this.headers,
      ...opts.headers,
    };
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json; charset=utf-8";
      body = JSON.stringify(opts.json);
    } else if (opts.raw) {
      headers["content-type"] = opts.raw.contentType;
      body = opts.raw.body;
    } else if (opts.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.form)) if (v !== undefined) p.append(k, String(v));
      body = p.toString();
    }
    const url = this.url(path, opts.query);
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new ProviderError(this.provider, 0, "network", true, `${method} ${path}: ${(err as Error).message}`);
    }
    const text = await res.text();
    let parsed: any;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
    if (res.ok || opts.allow?.includes(res.status)) return { status: res.status, body: parsed as T, headers: Object.fromEntries(res.headers) };
    const code = providerCode(parsed, res.status);
    const retryable = res.status === 429 || res.status >= 500;
    throw new ProviderError(this.provider, res.status, code, retryable, `${method} ${path} → ${res.status} ${code}`, retryable ? retryAfterMs(res) : undefined);
  }
}
