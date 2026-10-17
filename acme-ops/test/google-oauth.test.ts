import { afterEach, describe, expect, it, vi } from 'vitest';
import { googleAuthorization } from '../src/providers/google-oauth';
import { endpointsFromEnv } from '../src/providers';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('Google long-lived deployment authorization', () => {
 it('single-flights concurrent requests, caches, and refreshes after expiry', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({access_token:'first',expires_in:120}))).mockResolvedValueOnce(new Response(JSON.stringify({access_token:'second',expires_in:120})));
  vi.stubGlobal('fetch',fetcher);
  const auth=googleAuthorization('gmail','client','secret','refresh');
  expect(await Promise.all([auth(),auth(),auth()])).toEqual(['Bearer first','Bearer first','Bearer first']); expect(fetcher).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(61000); expect(await auth()).toBe('Bearer second'); expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('reports refresh refusal without leaking response and retries on a later call', async () => {
  const fetcher=vi.fn().mockResolvedValueOnce(new Response('private-secret',{status:400})).mockResolvedValueOnce(new Response(JSON.stringify({access_token:'new'})));vi.stubGlobal('fetch',fetcher);
  const auth=googleAuthorization('gmail','client','secret','refresh'); await expect(auth()).rejects.toThrow('Google token refresh refused'); expect(await auth()).toBe('Bearer new');
 });
 it('keeps explicit twin credentials and enables OAuth only for native Google', () => {
  const creds={GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',GOOGLE_REFRESH_TOKEN:'refresh'};
  expect(endpointsFromEnv(creds).gmail?.getAuthorization).toBeTypeOf('function');
  const twin=endpointsFromEnv({...creds,GMAIL_BASE_URL:'https://twin.example',GMAIL_API_KEY:'twin-key'}).gmail!;
  expect(twin.token).toBe('twin-key');expect(twin.getAuthorization).toBeUndefined();
 });
});
