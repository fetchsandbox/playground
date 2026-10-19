import { afterEach, describe, expect, it, vi } from 'vitest';
import { zendeskAuthorization } from '../src/providers/zendesk-oauth';
import { endpointsFromEnv } from '../src/providers';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('Zendesk scoped client credentials', () => {
 it('single-flights concurrent tokens and renews an expired token with exact scope', async () => {
  vi.useFakeTimers(); const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({access_token:'one',expires_in:120}))).mockResolvedValueOnce(new Response(JSON.stringify({access_token:'two',expires_in:120})));vi.stubGlobal('fetch',fetcher);
  const auth=zendeskAuthorization('https://demo.zendesk.com','id','secret','tickets:read');
  expect(await Promise.all([auth(),auth(),auth()])).toEqual(['Bearer one','Bearer one','Bearer one']);expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body)).toEqual({grant_type:'client_credentials',client_id:'id',client_secret:'secret',scope:'tickets:read',expires_in:3600});
  vi.advanceTimersByTime(61000);expect(await auth()).toBe('Bearer two');
 });
 it('redacts a refused token response, and permits later recovery', async () => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response('private-secret',{status:403})).mockResolvedValueOnce(new Response(JSON.stringify({access_token:'ok'}))));const auth=zendeskAuthorization('https://demo.zendesk.com','id','secret','tickets:read');
  await expect(auth()).rejects.toThrow('Zendesk token request refused');expect(await auth()).toBe('Bearer ok');
 });
 it('does not send native client secrets to twins or custom endpoints', () => {
  const c={ZENDESK_SUBDOMAIN:'demo',ZENDESK_CLIENT_ID:'id',ZENDESK_CLIENT_SECRET:'secret',ZENDESK_SCOPES:'tickets:read'};
  expect(endpointsFromEnv(c).zendesk?.getAuthorization).toBeTypeOf('function');
  const twin=endpointsFromEnv({...c,ZENDESK_BASE_URL:'https://twin.example',ZENDESK_API_KEY:'twin'}).zendesk!;expect(twin.token).toBe('twin');expect(twin.getAuthorization).toBeUndefined();
  expect(endpointsFromEnv({...c,ZENDESK_SCOPES:''}).zendesk).toBeUndefined();
 });
});
