import {describe,it,expect} from 'vitest';
// @ts-ignore The native workflow generator is also a Node CLI.
import {buildWorkflow,decisionSource,blindDealRetry,blindGmailResend} from '../n8n-lead-pilot/build-workflow.mjs';
describe('native n8n auth configuration',()=>{
 it('refuses an unsecured draft and a substituted runtime origin or route',()=>{
  const c={id:'fixture-reference',name:'Fixture credential (not a secret)'};
  expect(()=>buildWorkflow('https://adapter.example','friendly-pilot-mcp-20261106',null)).toThrow();
  for(const origin of ['http://adapter.example','https://user:password@adapter.example','https://adapter.example/path','https://adapter.example?key=value'])expect(()=>buildWorkflow(origin,'friendly-pilot-mcp-20261106',c)).toThrow();
  expect(()=>buildWorkflow('https://adapter.example','different-route',c)).toThrow();
 });
 it('uses native credential references on both network boundaries without inline bearer values',()=>{
  const c={id:'fixture-reference',name:'Fixture credential (not a secret)'};
  const workflow=buildWorkflow('https://adapter.example','friendly-pilot-mcp-20261106',c);
  const webhook=workflow.nodes.find((n:any)=>n.name==='Lead webhook');
  const io=workflow.nodes.find((n:any)=>n.name==='State or isolated twin I/O');
  expect(webhook.parameters.authentication).toBe('headerAuth');expect(webhook.credentials.httpHeaderAuth).toEqual(c);
  expect(io.parameters.authentication).toBe('genericCredentialType');expect(io.parameters.genericAuthType).toBe('httpHeaderAuth');expect(io.credentials.httpHeaderAuth).toEqual(c);
  expect(JSON.stringify(workflow)).not.toContain('Bearer ');expect(io.parameters).not.toHaveProperty('headerParameters');expect(workflow.active).toBe(false);
 });
});

it('the explicit broken decision variant replaces reconciliation with a second Deal write only',()=>{
 const next={context:{stage:'reconciled',lead_id:'ordinary-lead',state:{operations:{contact:{id:'contact-id'}}}},request:{kind:'provider',provider:'hubspot',method:'POST',path:'/crm/v3/objects/deals/search',body:{}}};
 const broken=blindDealRetry(structuredClone(next));
 expect(broken.request.path).toBe('/crm/v3/objects/deals');expect(broken.context.stage).toBe('effect');
 expect(broken.request.body.associations[0].to.id).toBe('contact-id');
 const unrelated={context:{},request:{kind:'provider',provider:'gmail',method:'POST',path:'/gmail/v1/users/me/messages/send'}};
 expect(blindDealRetry(structuredClone(unrelated))).toEqual(unrelated);
 expect(()=>decisionSource('unregistered')).toThrow();
 expect(decisionSource('normal')).not.toContain('const normalAdvance=advance');
});

it('the explicit Gmail resend mutation changes only unknown-message reconciliation',()=>{
 const input={context:{stage:'reconciled',raw:'opaque-fixture-mime'},request:{kind:'provider',provider:'gmail',method:'GET',path:'/gmail/v1/users/me/messages?q=rfc822msgid%3Aordinary%40example.com'}};
 const next=blindGmailResend(structuredClone(input));
 expect(next.context.stage).toBe('effect');expect(next.request).toEqual({kind:'provider',provider:'gmail',method:'POST',path:'/gmail/v1/users/me/messages/send',body:{raw:'opaque-fixture-mime'}});
 for(const q of [{kind:'provider',provider:'gmail',method:'GET',path:'/gmail/v1/users/me/messages/exact-id'},{kind:'provider',provider:'hubspot',method:'POST',path:'/crm/v3/objects/deals/search'}]){
  const other={context:{},request:q};expect(blindGmailResend(structuredClone(other))).toEqual(other);
 }
});
