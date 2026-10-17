import { ProviderError } from '../kit/errors';

/** Short-lived tokens issued to the approved Zendesk client, cached per process. */
export function zendeskAuthorization(baseUrl: string, clientId: string, clientSecret: string, scope: string) {
  let cached: { token: string; until: number } | undefined;
  let pending: Promise<string> | undefined;
  return async (): Promise<string> => {
    if (cached && cached.until > Date.now() + 60_000) return `Bearer ${cached.token}`;
    pending ??= (async () => {
      let response: Response;
      try {
        response = await fetch(`${baseUrl.replace(/\/+$/, '')}/oauth/tokens`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope, expires_in: 3600 }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new ProviderError('zendesk', 0, 'oauth_refresh_network', true, 'Zendesk token request unavailable');
      }
      if (!response.ok) throw new ProviderError('zendesk', response.status, 'oauth_refresh_failed', response.status === 429 || response.status >= 500, 'Zendesk token request refused');
      const data = await response.json() as { access_token?: string; expires_in?: number };
      if (!data.access_token) throw new ProviderError('zendesk', 502, 'oauth_invalid_response', false, 'Zendesk returned no access token');
      cached = { token: data.access_token, until: Date.now() + (data.expires_in ?? 3600) * 1000 };
      return `Bearer ${data.access_token}`;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
