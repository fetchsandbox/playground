import { ProviderError } from '../kit/errors';

/** Long-lived refresh credentials, never an expiring access token in deployment config. */
export function googleAuthorization(provider: string, clientId: string, clientSecret: string, refreshToken: string) {
  let cached: { token: string; until: number } | undefined;
  let pending: Promise<string> | undefined;
  return async (): Promise<string> => {
    if (cached && cached.until > Date.now() + 60_000) return `Bearer ${cached.token}`;
    pending ??= (async () => {
      let response: Response;
      try {
        response = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new ProviderError(provider, 0, 'oauth_refresh_network', true, 'Google token refresh unavailable');
      }
      // Do not include OAuth response bodies or credentials in exported errors.
      if (!response.ok) throw new ProviderError(provider, response.status, 'oauth_refresh_failed', response.status === 429 || response.status >= 500, 'Google token refresh refused');
      const data = await response.json() as { access_token?: string; expires_in?: number };
      if (!data.access_token) throw new ProviderError(provider, 502, 'oauth_invalid_response', false, 'Google token refresh returned no access token');
      cached = { token: data.access_token, until: Date.now() + (data.expires_in ?? 3600) * 1000 };
      return `Bearer ${data.access_token}`;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
