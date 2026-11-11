import {describe,it,expect,vi} from 'vitest';
import {allowedProviderOperation,callTwin} from '../n8n-lead-pilot/provider-transport';
const binding={base_url:'https://fetchsandbox.com/sandbox/fixture',api_key:'disposable-fixture-only'};
describe('pilot provider egress boundary',()=>{
 it.each([
 ['hubspot','POST','/crm/v3/objects/contacts/search'],['hubspot','POST','/crm/v3/objects/deals'],['hubspot','GET','/crm/v3/objects/deals/d_1?associations=contacts'],['gmail','POST','/gmail/v1/users/me/messages/send'],['gmail','GET','/gmail/v1/users/me/messages?q=rfc822msgid%3Apilot%40example.com'],['gmail','GET','/gmail/v1/users/me/messages/m_1'],['google-calendar','POST','/calendars/primary/events'],['google-calendar','GET','/calendars/primary/events/f0123456789'],['slack','GET','/conversations.history?channel=C_PILOT&limit=100'],['slack','POST','/chat.postMessage'],
 ])('permits the workflow operation %s %s %s',(provider,method,path)=>expect(allowedProviderOperation({provider,method,path})).toBe(true));
 it.each([
 ['slack','GET','/chat.postMessage'],['slack','GET','/conversations.history?channel=OTHER&limit=100'],['slack','GET','/conversations.history?channel=C_PILOT&limit=100&token=secret'],['google-calendar','GET','/calendars/foreign/events/f01234'],['google-calendar','GET','/calendars/primary/events/../other'],['gmail','POST','/gmail/v1/users/me/messages/m_1'],['gmail','DELETE','/gmail/v1/users/me/messages/m_1'],['gmail','GET','https://gmail.googleapis.com/gmail/v1/users/me/messages'],['gmail','GET','//outside.example/'],['gmail','GET','/gmail/v1/users/me/messages?q=x#secret'],['gmail','GET','/gmail/v1/users/me/messages/../send'],['gmail','GET','/gmail/v1/users/me/messages/%2e%2e'],['hubspot','GET','/crm/v3/objects/deals/search/extra'],['hubspot','POST','/crm/v3/objects/deals/d_1'],['__proto__','POST','/chat.postMessage'],
 ])('refuses %s %s %s',(provider,method,path)=>expect(allowedProviderOperation({provider,method,path})).toBe(false));
 it('refuses foreign/first-party-non-twin/substituted bindings before network I/O',async()=>{
  const transport=vi.fn();
  for(const base_url of ['https://outside.example/sandbox/a','https://fetchsandbox.com/api/accounts','https://fetchsandbox.com/sandbox/a/../admin','https://fetchsandbox.com/sandbox/a?key=x','https://fetchsandbox.com.evil.example/sandbox/a'])await expect(callTwin({...binding,base_url},{method:'GET',path:'/x'},undefined,transport)).rejects.toThrow('non-twin');
  expect(transport).not.toHaveBeenCalled();
 });
 it('sends only the issued credential to the fixed twin and refuses redirects without retry',async()=>{
  const transport=vi.fn(async()=>new Response('{}',{status:200}));
  await callTwin(binding,{method:'GET',path:'/gmail/v1/users/me/messages/m_1'},'run-fixture',transport);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0]).toMatchObject(['https://fetchsandbox.com/sandbox/fixture/gmail/v1/users/me/messages/m_1',{redirect:'error',headers:{authorization:'Bearer disposable-fixture-only','x-flow-run-id':'run-fixture'}}]);
  const redirected=vi.fn(async()=>{throw Error('redirect refused');});
  expect(await callTwin(binding,{method:'GET',path:'/x'},undefined,redirected)).toMatchObject({status:0,transport:'unknown'});expect(redirected).toHaveBeenCalledTimes(1);
 });
});

it('allows only the fixed unique Deal read query, not arbitrary properties or other objects',()=>{
 const q={provider:'hubspot',method:'GET',path:'/crm/v3/objects/deals/lead?idProperty=fetchsandbox_pilot_lead_id&properties=dealname%2Cfetchsandbox_pilot_lead_id&associations=contacts'};
 expect(allowedProviderOperation(q)).toBe(true);
 expect(allowedProviderOperation({...q,path:q.path.replace('fetchsandbox_pilot_lead_id','email')})).toBe(false);
 expect(allowedProviderOperation({...q,path:q.path.replace('/deals/','/contacts/')})).toBe(false);
 expect(allowedProviderOperation({...q,path:q.path+'&extra=1'})).toBe(false);
});
