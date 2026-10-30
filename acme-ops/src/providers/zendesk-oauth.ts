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
          // An expired Zendesk trial redirects OAuth to an HTML account page.
          // Do not follow redirects with the client-credentials request.
          redirect: 'manual',
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new ProviderError('zendesk', 0, 'oauth_refresh_network', true, 'Zendesk token request unavailable');
      }
      if (response.status >= 300 && response.status < 400) {
        let expiredTrial = false;
        try {
          const target = new URL(response.headers.get('location') ?? '', baseUrl);
          expiredTrial = target.origin === new URL(baseUrl).origin && target.pathname === '/agent/expired-trial';
        } catch { /* Unrecognized redirects use the existing refusal below. */ }
        if (expiredTrial) throw new ProviderError('zendesk', response.status, 'account_trial_expired', false, 'Zendesk trial expired; reactivate the account before retrying');
      }
      if (!response.ok) throw new ProviderError('zendesk', response.status, 'oauth_refresh_failed', response.status === 429 || response.status >= 500, 'Zendesk token request refused');
      let data: { access_token?: string; expires_in?: number };
      try { data = await response.json() as typeof data; }
      catch { throw new ProviderError('zendesk', 502, 'oauth_invalid_response', false, 'Zendesk token response was not JSON'); }
      if (!data.access_token) throw new ProviderError('zendesk', 502, 'oauth_invalid_response', false, 'Zendesk returned no access token');
      cached = { token: data.access_token, until: Date.now() + (data.expires_in ?? 3600) * 1000 };
      return `Bearer ${data.access_token}`;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
