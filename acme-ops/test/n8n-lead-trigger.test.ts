import {describe,it,expect,vi} from 'vitest';
import {invokeN8n,N8N_PILOT_WEBHOOK} from '../n8n-lead-pilot/trigger';
const binding={n8n_webhook:N8N_PILOT_WEBHOOK,n8n_token:'disposable-fixture-only'};
describe('persistent n8n trigger safety',()=>{
 it('refuses temporary, foreign and uncredentialed bindings without network effects',async()=>{
  const transport=vi.fn();
  for(const cfg of [{...binding,n8n_webhook:N8N_PILOT_WEBHOOK.replace('/webhook/','/webhook-test/')},{...binding,n8n_webhook:'https://outside.example/webhook/x'},{...binding,n8n_token:''}])expect((await invokeN8n(cfg,'{"lead_id":"one"}',transport)).status).toBe(503);
  expect(transport).not.toHaveBeenCalled();
 });
 it('rejects malformed and unexpected input before invoking the runtime',async()=>{
  const transport=vi.fn();
  for(const raw of ['{}','null','[]','{','{"lead_id":"bad value"}','{"lead_id":"one","retry_failed":"yes"}','{"lead_id":"one","target":"elsewhere"}'])expect((await invokeN8n(binding,raw,transport)).status).toBe(400);
  expect(transport).not.toHaveBeenCalled();
 });
 it('supports repeated authenticated deliveries without arming and refuses redirects',async()=>{
  const transport=vi.fn(async()=>new Response(JSON.stringify({status:'confirmed'}),{status:200}));
  for(let i=0;i<2;i++)expect((await invokeN8n(binding,'{"lead_id":"one"}',transport)).status).toBe(200);
  expect(transport).toHaveBeenCalledTimes(2);
  for(const [url,options] of transport.mock.calls as unknown as [string,RequestInit][]){expect(url).toBe(N8N_PILOT_WEBHOOK);expect(options.headers).toMatchObject({authorization:'Bearer disposable-fixture-only'});expect(options.redirect).toBe('error');}
 });
 it('preserves uncertain outcomes and does not retry a lost response',async()=>{
  const transport=vi.fn(async()=>{throw new Error('Response lost after acceptance');});
  expect(await invokeN8n(binding,'{"lead_id":"one"}',transport)).toEqual({status:504,body:{error:'n8n_outcome_unknown',automatic_retry:false}});
  expect(transport).toHaveBeenCalledTimes(1);
 });
 it('retains a native authentication refusal rather than inventing success',async()=>{
  const transport=vi.fn(async()=>new Response('{"error":"unauthorized"}',{status:401}));
  expect((await invokeN8n(binding,'{"lead_id":"one"}',transport)).status).toBe(401);
 });
});
