import {describe,it,expect,vi} from 'vitest';
import {invokeN8n,invokeNativeN8n,N8N_PILOT_WEBHOOK} from '../n8n-lead-pilot/trigger';
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
 it.each([401,403])('retains native authentication refusal %s rather than inventing success',async status=>{
  const transport=vi.fn(async()=>new Response('{"error":"unauthorized"}',{status}));
  expect((await invokeN8n(binding,'{"lead_id":"one"}',transport)).status).toBe(status);
 });
 it.each([[500,500],[200,502]])('preserves upstream %s when the response is not JSON',async (upstream,expected)=>{
  const transport=vi.fn(async()=>new Response('Native diagnostic text, no customer data',{status:upstream}));
  const result=await invokeN8n(binding,'{"lead_id":"one"}',transport);
  expect(result).toEqual({status:expected,body:{error:'n8n_non_json_response',upstream_status:upstream,automatic_retry:false}});expect(transport).toHaveBeenCalledTimes(1);
 });
});

// Native boundary qualification must reach n8n with unchanged business input.
describe('fixed native entry transport',()=>{
 it('forwards invalid business input unchanged and preserves native rejection',async()=>{
  const raw=JSON.stringify({lead_id:'ordinary',retry_failed:'invalid'});
  const transport=vi.fn(async()=>new Response('{"status":"rejected"}',{status:400}));
  expect(await invokeNativeN8n(binding,raw,transport)).toEqual({status:400,body:{status:'rejected'}});
  expect(transport).toHaveBeenCalledTimes(1);
  const [url,options]=transport.mock.calls[0] as unknown as [string,RequestInit];
  expect(url).toBe(N8N_PILOT_WEBHOOK);expect(options.body).toBe(raw);expect(options.redirect).toBe('error');
  expect(options.headers).toMatchObject({authorization:'Bearer disposable-fixture-only'});
 });
 it('cannot substitute a destination, inject a credential header or retry an unknown outcome',async()=>{
  const transport=vi.fn(async()=>{throw Error('lost response');});
  for(const cfg of [{...binding,n8n_webhook:'https://other.example/'},{...binding,n8n_token:'bad\r\nheader'},{...binding,n8n_token:''}])
   expect((await invokeNativeN8n(cfg,'{}',transport)).status).toBe(503);
  expect(transport).not.toHaveBeenCalled();
  expect((await invokeNativeN8n(binding,'{}',transport)).body).toMatchObject({automatic_retry:false});
  expect(transport).toHaveBeenCalledTimes(1);
 });
});
